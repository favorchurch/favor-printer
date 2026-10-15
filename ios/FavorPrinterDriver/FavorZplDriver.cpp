#include <os/log.h>
#include <string.h>
#include <DriverKit/IOUserServer.h>
#include <DriverKit/IOUserClient.h>
#include <DriverKit/IOLib.h>
#include <DriverKit/IOBufferMemoryDescriptor.h>
#include <DriverKit/OSData.h>
#include <USBDriverKit/IOUSBHostDevice.h>
#include <USBDriverKit/IOUSBHostInterface.h>
#include <USBDriverKit/IOUSBHostPipe.h>
#include <USBDriverKit/AppleUSBDescriptorParsing.h>
#include "FavorZplDriver.h"
#include "FavorZplUserClientABI.h"

// Only sizes and IOReturn codes are logged, never the bytes moved.
#define LOG(fmt, ...) os_log(OS_LOG_DEFAULT, "FavorZplDriver: " fmt, ##__VA_ARGS__)

namespace {
constexpr uint32_t kWriteChunkBytes = 16 * 1024;
constexpr uint32_t kWriteTimeoutMs = 5000;
// After the first transfer, keep collecting until the printer goes quiet: ~HS answers arrive in several transfers.
constexpr uint32_t kFollowUpReadTimeoutMs = 50;
}

struct FavorZplDriver_IVars {
	IOUSBHostInterface *interface = nullptr;
	IOUSBHostPipe *outPipe = nullptr;
	IOUSBHostPipe *inPipe = nullptr;
	uint32_t stage = 0;
	int32_t error = 0;
	uint32_t outAddress = 0;
	uint32_t inAddress = 0;   // 0 unless the bulk IN pipe opened
	uint8_t serial[kFavorZplMaxSerialBytes] = {};
	uint32_t serialLength = 0;
	// One transfer at a time: two user clients could otherwise interleave labels on the bulk OUT pipe.
	uint32_t busy = 0;
};

static bool TryAcquire(FavorZplDriver_IVars *ivars)
{
	return __atomic_exchange_n(&ivars->busy, 1, __ATOMIC_ACQUIRE) == 0;
}

static void Release(FavorZplDriver_IVars *ivars)
{
	__atomic_store_n(&ivars->busy, 0, __ATOMIC_RELEASE);
}

// Best effort: leaves the serial empty when the descriptor has none or any step fails.
static void ReadSerial(IOUSBHostInterface *interface, uint8_t *serial, uint32_t *serialLength)
{
	IOUSBHostDevice *device = nullptr;
	if (interface->CopyDevice(&device) != kIOReturnSuccess || device == nullptr) return;
	const IOUSBDeviceDescriptor *deviceDescriptor = device->CopyDeviceDescriptor();
	if (deviceDescriptor != nullptr) {
		uint8_t index = deviceDescriptor->iSerialNumber;
		IOFree((void *)deviceDescriptor, deviceDescriptor->bLength);
		const IOUSBStringDescriptor *string = index != 0 ? device->CopyStringDescriptor(index) : nullptr;
		if (string != nullptr) {
			uint8_t length = string->bLength;
			uint32_t count = 0;
			// UTF-16LE. Zebra serials are ASCII, anything else becomes '?'.
			for (uint32_t i = 2; i + 1 < length && count < kFavorZplMaxSerialBytes; i += 2) {
				uint16_t unit = (uint16_t)(((const uint8_t *)string)[i] | (((const uint8_t *)string)[i + 1] << 8));
				if (unit == 0) break;
				serial[count++] = (unit >= 0x20 && unit < 0x7f) ? (uint8_t)unit : '?';
			}
			*serialLength = count;
			IOFree((void *)string, length);
		}
	}
	OSSafeReleaseNULL(device);
}

bool FavorZplDriver::init()
{
	if (!super::init()) return false;
	ivars = IONewZero(FavorZplDriver_IVars, 1);
	return ivars != nullptr;
}

void FavorZplDriver::free()
{
	IOSafeDeleteNULL(ivars, FavorZplDriver_IVars, 1);
	super::free();
}

kern_return_t IMPL(FavorZplDriver, Start)
{
	kern_return_t ret = Start(provider, SUPERDISPATCH);
	ivars->stage = kFavorZplStageSuperStart;
	ivars->error = ret;
	if (ret != kIOReturnSuccess) return ret;

	// Register first and never fail after this point, so the app can always read the stage reached.
	RegisterService();

	ivars->interface = OSDynamicCast(IOUSBHostInterface, provider);
	if (ivars->interface == nullptr) {
		ivars->stage = kFavorZplStageProviderCast;
		ivars->error = kIOReturnBadArgument;
		return kIOReturnSuccess;
	}
	ivars->interface->retain();
	ivars->stage = kFavorZplStageRetained;

	ret = ivars->interface->Open(this, 0, nullptr);
	if (ret != kIOReturnSuccess) {
		ivars->stage = kFavorZplStageOpening;
		ivars->error = ret;
		LOG("interface Open failed 0x%x", ret);
		return kIOReturnSuccess;
	}
	ivars->stage = kFavorZplStageOpened;

	// Find the bulk endpoints from the descriptors instead of assuming addresses.
	const IOUSBConfigurationDescriptor *config = ivars->interface->CopyConfigurationDescriptor();
	if (config == nullptr) {
		ivars->error = kIOReturnNotFound;
		return kIOReturnSuccess;
	}
	ivars->stage = kFavorZplStageDescriptorRead;
	const IOUSBInterfaceDescriptor *iface = ivars->interface->GetInterfaceDescriptor(config);
	uint8_t outAddress = 0;
	uint8_t inAddress = 0;
	const IOUSBDescriptorHeader *cursor = nullptr;
	while (iface != nullptr && (outAddress == 0 || inAddress == 0)) {
		const IOUSBEndpointDescriptor *ep = IOUSBGetNextEndpointDescriptor(config, iface, cursor);
		if (ep == nullptr) break;
		cursor = (const IOUSBDescriptorHeader *)ep;
		if (IOUSBGetEndpointType(ep) != kIOUSBEndpointTypeBulk) continue;
		if (IOUSBGetEndpointDirection(ep) == kIOUSBEndpointDirectionOut) {
			if (outAddress == 0) outAddress = IOUSBGetEndpointAddress(ep);
		} else if (inAddress == 0) {
			inAddress = IOUSBGetEndpointAddress(ep);
		}
	}
	IOFree((void *)config, config->wTotalLength);
	if (outAddress == 0) {
		ivars->error = kIOReturnNotFound;
		LOG("no bulk OUT endpoint");
		return kIOReturnSuccess;
	}
	ivars->outAddress = outAddress;
	ivars->stage = kFavorZplStageBulkOutFound;

	ret = ivars->interface->CopyPipe(outAddress, &ivars->outPipe);
	ivars->error = ret;
	LOG("started, bulk OUT 0x%x bulk IN 0x%x, CopyPipe ret=0x%x", outAddress, inAddress, ret);
	if (ret != kIOReturnSuccess) return kIOReturnSuccess;
	ivars->stage = kFavorZplStageReady;

	// Optional extras. A printer without a usable bulk IN endpoint still prints.
	if (inAddress != 0 && ivars->interface->CopyPipe(inAddress, &ivars->inPipe) == kIOReturnSuccess) {
		ivars->inAddress = inAddress;
	}
	ReadSerial(ivars->interface, ivars->serial, &ivars->serialLength);
	return kIOReturnSuccess;
}

kern_return_t IMPL(FavorZplDriver, Stop)
{
	LOG("stopped");
	OSSafeReleaseNULL(ivars->outPipe);
	OSSafeReleaseNULL(ivars->inPipe);
	if (ivars->interface != nullptr) {
		ivars->interface->Close(this, 0);
		OSSafeReleaseNULL(ivars->interface);
	}
	return Stop(provider, SUPERDISPATCH);
}

kern_return_t FavorZplDriver::NewUserClient_Impl(uint32_t type, IOUserClient **userClient)
{
	IOService *client = nullptr;
	kern_return_t ret = Create(this, "UserClientProperties", &client);
	if (ret != kIOReturnSuccess) {
		LOG("Create user client failed 0x%x", ret);
		return ret;
	}
	*userClient = OSDynamicCast(IOUserClient, client);
	return *userClient != nullptr ? kIOReturnSuccess : kIOReturnError;
}

void FavorZplDriver::GetStatus(uint32_t *stage, int32_t *error, uint32_t *bulkOutAddress, uint32_t *bulkInAddress,
                               uint8_t *serial, uint32_t *serialLength)
{
	*stage = ivars->stage;
	*error = ivars->error;
	*bulkOutAddress = ivars->outAddress;
	*bulkInAddress = ivars->inAddress;
	*serialLength = ivars->serialLength;
	memcpy(serial, ivars->serial, ivars->serialLength);
}

kern_return_t FavorZplDriver::SendRaw(const void *bytes, uint32_t length, uint32_t *transferred, int32_t *ioReturn)
{
	*transferred = 0;
	*ioReturn = kIOReturnSuccess;
	if (bytes == nullptr || length == 0) return kIOReturnBadArgument;
	if (length > kFavorZplMaxSendBytes) return kIOReturnMessageTooLarge;
	if (ivars->outPipe == nullptr) return kIOReturnNotReady;
	if (!TryAcquire(ivars)) return kIOReturnBusy;

	uint32_t capacity = length < kWriteChunkBytes ? length : kWriteChunkBytes;
	IOBufferMemoryDescriptor *buffer = nullptr;
	kern_return_t ret = IOBufferMemoryDescriptor::Create(kIOMemoryDirectionOut, capacity, 0, &buffer);
	IOAddressSegment segment = {};
	if (ret == kIOReturnSuccess) ret = buffer->GetAddressRange(&segment);
	if (ret != kIOReturnSuccess) {
		OSSafeReleaseNULL(buffer);
		Release(ivars);
		return ret;
	}

	uint32_t offset = 0;
	while (offset < length) {
		uint32_t chunk = length - offset < capacity ? length - offset : capacity;
		memcpy((void *)segment.address, (const uint8_t *)bytes + offset, chunk);
		buffer->SetLength(chunk);
		uint32_t moved = 0;
		kern_return_t usb = ivars->outPipe->IO(buffer, chunk, &moved, kWriteTimeoutMs);
		*transferred += moved;
		if (usb != kIOReturnSuccess) {
			*ioReturn = usb;
			break;
		}
		if (moved < chunk) break;
		offset += chunk;
	}
	LOG("SendRaw length=%u transferred=%u ioReturn=0x%x", length, *transferred, *ioReturn);
	OSSafeReleaseNULL(buffer);
	Release(ivars);
	return kIOReturnSuccess;
}

kern_return_t FavorZplDriver::ReadBulkIn(uint32_t timeoutMs, uint8_t *out, uint32_t capacity, uint32_t *bytesRead,
                                         int32_t *ioReturn)
{
	*bytesRead = 0;
	*ioReturn = kIOReturnSuccess;
	if (out == nullptr || capacity == 0) return kIOReturnBadArgument;
	if (ivars->inPipe == nullptr) return kIOReturnNotFound;
	if (!TryAcquire(ivars)) return kIOReturnBusy;

	IOBufferMemoryDescriptor *buffer = nullptr;
	kern_return_t ret = IOBufferMemoryDescriptor::Create(kIOMemoryDirectionIn, capacity, 0, &buffer);
	IOAddressSegment segment = {};
	if (ret == kIOReturnSuccess) ret = buffer->GetAddressRange(&segment);
	if (ret != kIOReturnSuccess) {
		OSSafeReleaseNULL(buffer);
		Release(ivars);
		return ret;
	}

	uint32_t wait = timeoutMs;
	while (*bytesRead < capacity) {
		buffer->SetLength(capacity - *bytesRead);
		uint32_t moved = 0;
		kern_return_t usb = ivars->inPipe->IO(buffer, capacity - *bytesRead, &moved, wait);
		if (usb != kIOReturnSuccess) {
			// Bytes already collected win over a trailing timeout.
			if (*bytesRead == 0) *ioReturn = usb;
			break;
		}
		if (moved == 0) break;
		memcpy(out + *bytesRead, (const void *)segment.address, moved);
		*bytesRead += moved;
		wait = kFollowUpReadTimeoutMs;
	}
	LOG("ReadBulkIn bytesRead=%u ioReturn=0x%x", *bytesRead, *ioReturn);
	OSSafeReleaseNULL(buffer);
	Release(ivars);
	return kIOReturnSuccess;
}
