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
#include <USBDriverKit/USBDriverKitDefs.h>
#include "FavorZplDriver.h"
#include "FavorZplUserClientABI.h"

// Only sizes and IOReturn codes are logged, never the bytes moved.
#define LOG(fmt, ...) os_log(OS_LOG_DEFAULT, "FavorZplDriver: " fmt, ##__VA_ARGS__)

namespace {
constexpr uint32_t kWriteChunkBytes = 16 * 1024;
constexpr uint32_t kWriteTimeoutMs = 5000;
// After the first transfer, keep collecting until the printer goes quiet: ~HS answers arrive in several transfers.
constexpr uint32_t kFollowUpReadTimeoutMs = 50;
// Longest Stop waits for an in-flight transfer: a write timeout plus margin.
constexpr uint32_t kStopWaitMs = kWriteTimeoutMs + 1000;
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
	FavorZplGate gate = {};
};

// Holds the gate for the rest of the scope.
struct ScopedGate {
	FavorZplGate *gate;
	explicit ScopedGate(FavorZplGate *gate) : gate(gate) {}
	~ScopedGate() { FavorZplGateRelease(gate); }
};

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

	// Hold the gate until set-up is done, so a client that finds the service early cannot start a transfer on
	// half-built state. Status reads take no gate and rely on the release stores below.
	FavorZplGateTryAcquire(&ivars->gate);
	ScopedGate setUp(&ivars->gate);

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
	__atomic_store_n(&ivars->stage, kFavorZplStageReady, __ATOMIC_RELEASE);

	// Optional extras. A printer without a usable bulk IN endpoint still prints.
	if (inAddress != 0 && ivars->interface->CopyPipe(inAddress, &ivars->inPipe) == kIOReturnSuccess) {
		__atomic_store_n(&ivars->inAddress, (uint32_t)inAddress, __ATOMIC_RELEASE);
	}
	uint32_t serialLength = 0;
	ReadSerial(ivars->interface, ivars->serial, &serialLength);
	__atomic_store_n(&ivars->serialLength, serialLength, __ATOMIC_RELEASE);
	return kIOReturnSuccess;
}

kern_return_t IMPL(FavorZplDriver, Stop)
{
	LOG("stopped");
	// Close the gate so no transfer starts, abort the one in flight, and wait for it to leave before the pipes go.
	FavorZplGateClose(&ivars->gate);
	bool drained = false;
	for (uint32_t waited = 0; !(drained = FavorZplGateTryDrain(&ivars->gate)) && waited < kStopWaitMs; waited += 10) {
		if (ivars->outPipe != nullptr) ivars->outPipe->Abort(kIOUSBAbortAsynchronous, kIOReturnAborted, nullptr);
		if (ivars->inPipe != nullptr) ivars->inPipe->Abort(kIOUSBAbortAsynchronous, kIOReturnAborted, nullptr);
		IOSleep(10);
	}
	if (!drained) {
		// A transfer is still using the pipes. Leaking the pipe and interface references beats freeing them under it.
		// Closing the interface still ends the transfer and lets the provider terminate.
		LOG("stop: transfer did not finish, leaving pipes in place");
		if (ivars->interface != nullptr) ivars->interface->Close(this, 0);
		return Stop(provider, SUPERDISPATCH);
	}
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
	// Status takes no gate (it must answer during a transfer), so it reads what Start published with acquire loads.
	uint32_t length = __atomic_load_n(&ivars->serialLength, __ATOMIC_ACQUIRE);
	*stage = __atomic_load_n(&ivars->stage, __ATOMIC_ACQUIRE);
	*error = ivars->error;
	*bulkOutAddress = ivars->outAddress;
	*bulkInAddress = __atomic_load_n(&ivars->inAddress, __ATOMIC_ACQUIRE);
	*serialLength = length;
	memcpy(serial, ivars->serial, length);
}

kern_return_t FavorZplDriver::SendRaw(const void *bytes, uint32_t length, uint32_t *transferred, int32_t *ioReturn)
{
	*transferred = 0;
	*ioReturn = kIOReturnSuccess;
	if (bytes == nullptr || length == 0) return kIOReturnBadArgument;
	if (length > kFavorZplMaxSendBytes) return kIOReturnMessageTooLarge;
	// Before the pipe exists (start-up, or a failed start) nothing was attempted. After Stop the printer is gone.
	if (FavorZplGateIsClosed(&ivars->gate)) {
		*ioReturn = kIOReturnNoDevice;
		return kIOReturnSuccess;
	}
	if (ivars->outPipe == nullptr) {
		// Stop closes the gate before it nulls the pipes, so a closed gate here means Stop got in between.
		if (FavorZplGateIsClosed(&ivars->gate)) {
			*ioReturn = kIOReturnNoDevice;
			return kIOReturnSuccess;
		}
		return kIOReturnNotReady;
	}
	if (!FavorZplGateTryAcquire(&ivars->gate)) return kIOReturnBusy;
	ScopedGate gate(&ivars->gate);

	uint32_t capacity = length < kWriteChunkBytes ? length : kWriteChunkBytes;
	IOBufferMemoryDescriptor *buffer = nullptr;
	kern_return_t ret = IOBufferMemoryDescriptor::Create(kIOMemoryDirectionOut, capacity, 0, &buffer);
	IOAddressSegment segment = {};
	if (ret == kIOReturnSuccess) ret = buffer->GetAddressRange(&segment);
	if (ret != kIOReturnSuccess) {
		OSSafeReleaseNULL(buffer);
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
	return kIOReturnSuccess;
}

kern_return_t FavorZplDriver::ReadBulkIn(uint32_t timeoutMs, uint8_t *out, uint32_t capacity, uint32_t *bytesRead,
                                         int32_t *ioReturn)
{
	*bytesRead = 0;
	*ioReturn = kIOReturnSuccess;
	if (out == nullptr || capacity == 0) return kIOReturnBadArgument;
	if (FavorZplGateIsClosed(&ivars->gate)) {
		*ioReturn = kIOReturnNoDevice;
		return kIOReturnSuccess;
	}
	if (ivars->inPipe == nullptr) {
		if (FavorZplGateIsClosed(&ivars->gate)) {
			*ioReturn = kIOReturnNoDevice;
			return kIOReturnSuccess;
		}
		return kIOReturnNotFound;
	}
	if (!FavorZplGateTryAcquire(&ivars->gate)) return kIOReturnBusy;
	ScopedGate gate(&ivars->gate);

	IOBufferMemoryDescriptor *buffer = nullptr;
	kern_return_t ret = IOBufferMemoryDescriptor::Create(kIOMemoryDirectionIn, capacity, 0, &buffer);
	IOAddressSegment segment = {};
	if (ret == kIOReturnSuccess) ret = buffer->GetAddressRange(&segment);
	if (ret != kIOReturnSuccess) {
		OSSafeReleaseNULL(buffer);
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
	return kIOReturnSuccess;
}
