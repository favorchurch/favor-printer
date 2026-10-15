#include <os/log.h>
#include <DriverKit/IOUserServer.h>
#include <DriverKit/IOLib.h>
#include <DriverKit/IOMemoryDescriptor.h>
#include <DriverKit/IOMemoryMap.h>
#include <DriverKit/OSData.h>
#include "FavorPrinterUsbDriver.h"
#include "FavorPrinterUsbUserClient.h"
#include "FavorZplUserClientABI.h"

struct FavorPrinterUsbUserClient_IVars {
	FavorPrinterUsbDriver *driver = nullptr;
};

bool FavorPrinterUsbUserClient::init()
{
	if (!super::init()) return false;
	ivars = IONewZero(FavorPrinterUsbUserClient_IVars, 1);
	return ivars != nullptr;
}

void FavorPrinterUsbUserClient::free()
{
	IOSafeDeleteNULL(ivars, FavorPrinterUsbUserClient_IVars, 1);
	super::free();
}

kern_return_t IMPL(FavorPrinterUsbUserClient, Start)
{
	kern_return_t ret = Start(provider, SUPERDISPATCH);
	if (ret != kIOReturnSuccess) return ret;
	ivars->driver = OSDynamicCast(FavorPrinterUsbDriver, provider);
	if (ivars->driver == nullptr) return kIOReturnBadArgument;
	ivars->driver->retain();
	return kIOReturnSuccess;
}

kern_return_t IMPL(FavorPrinterUsbUserClient, Stop)
{
	OSSafeReleaseNULL(ivars->driver);
	return Stop(provider, SUPERDISPATCH);
}

static bool HasScalarOutput(const IOUserClientMethodArguments *arguments, uint32_t count)
{
	return arguments->scalarOutput != nullptr && arguments->scalarOutputCount >= count;
}

// Hands `length` bytes to the caller as structure output, truncated to what the caller has room for.
static void SetStructureOutput(IOUserClientMethodArguments *arguments, const uint8_t *bytes, uint32_t length)
{
	if (arguments->structureOutputDescriptor != nullptr || length == 0) return;
	if (length > arguments->structureOutputMaximumSize) length = (uint32_t)arguments->structureOutputMaximumSize;
	arguments->structureOutput = OSData::withBytes(bytes, length);
}

static kern_return_t SendRawSelector(FavorPrinterUsbDriver *driver, IOUserClientMethodArguments *arguments)
{
	if (!HasScalarOutput(arguments, kFavorZplSendResultCount)) return kIOReturnBadArgument;

	const void *bytes = nullptr;
	uint64_t length = 0;
	IOMemoryMap *map = nullptr;
	if (arguments->structureInput != nullptr) {
		bytes = arguments->structureInput->getBytesNoCopy();
		length = arguments->structureInput->getLength();
	} else if (arguments->structureInputDescriptor != nullptr) {
		// Large structures arrive as a descriptor instead of OSData.
		kern_return_t ret = arguments->structureInputDescriptor->GetLength(&length);
		if (ret != kIOReturnSuccess) return ret;
		if (length > kFavorZplMaxSendBytes) return kIOReturnMessageTooLarge;
		ret = arguments->structureInputDescriptor->CreateMapping(kIOMemoryMapReadOnly, 0, 0, 0, 0, &map);
		if (ret != kIOReturnSuccess) return ret;
		bytes = (const void *)map->GetAddress();
		length = map->GetLength();
	} else {
		return kIOReturnBadArgument;
	}
	if (length > kFavorZplMaxSendBytes) {
		OSSafeReleaseNULL(map);
		return kIOReturnMessageTooLarge;
	}

	uint32_t transferred = 0;
	int32_t ioReturn = kIOReturnSuccess;
	kern_return_t ret = driver->SendRaw(bytes, (uint32_t)length, &transferred, &ioReturn);
	OSSafeReleaseNULL(map);
	arguments->scalarOutput[kFavorZplSendResultBytesWritten] = transferred;
	arguments->scalarOutput[kFavorZplSendResultIOReturn] = (uint32_t)ioReturn;
	return ret;
}

static kern_return_t StatusSelector(FavorPrinterUsbDriver *driver, IOUserClientMethodArguments *arguments)
{
	if (!HasScalarOutput(arguments, kFavorZplStatusFieldCount)) return kIOReturnBadArgument;
	uint32_t stage = 0, bulkOut = 0, bulkIn = 0, serialLength = 0;
	int32_t error = 0;
	uint8_t serial[kFavorZplMaxSerialBytes] = {};
	driver->GetStatus(&stage, &error, &bulkOut, &bulkIn, serial, &serialLength);
	arguments->scalarOutput[kFavorZplStatusStage] = stage;
	arguments->scalarOutput[kFavorZplStatusError] = (uint32_t)error;
	arguments->scalarOutput[kFavorZplStatusBulkOutAddress] = bulkOut;
	arguments->scalarOutput[kFavorZplStatusBulkInAddress] = bulkIn;
	arguments->scalarOutput[kFavorZplStatusABIVersion] = kFavorZplABIVersion;
	SetStructureOutput(arguments, serial, serialLength);
	return kIOReturnSuccess;
}

static kern_return_t ReadStatusSelector(FavorPrinterUsbDriver *driver, IOUserClientMethodArguments *arguments)
{
	if (!HasScalarOutput(arguments, kFavorZplReadResultCount)) return kIOReturnBadArgument;
	if (arguments->scalarInput == nullptr || arguments->scalarInputCount < 1) return kIOReturnBadArgument;
	uint64_t timeoutMs = arguments->scalarInput[0];
	if (timeoutMs < 1) timeoutMs = 1;
	if (timeoutMs > kFavorZplMaxReadTimeoutMs) timeoutMs = kFavorZplMaxReadTimeoutMs;

	uint8_t buffer[kFavorZplMaxReadBytes];
	uint32_t capacity = kFavorZplMaxReadBytes;
	if (arguments->structureOutputMaximumSize < capacity) capacity = (uint32_t)arguments->structureOutputMaximumSize;
	uint32_t bytesRead = 0;
	int32_t ioReturn = kIOReturnSuccess;
	kern_return_t ret = driver->ReadBulkIn((uint32_t)timeoutMs, buffer, capacity, &bytesRead, &ioReturn);
	if (ret != kIOReturnSuccess) return ret;
	arguments->scalarOutput[kFavorZplReadResultBytesRead] = bytesRead;
	arguments->scalarOutput[kFavorZplReadResultIOReturn] = (uint32_t)ioReturn;
	SetStructureOutput(arguments, buffer, bytesRead);
	return kIOReturnSuccess;
}

kern_return_t FavorPrinterUsbUserClient::ExternalMethod(uint64_t selector,
                                                 IOUserClientMethodArguments *arguments,
                                                 const IOUserClientMethodDispatch *dispatch,
                                                 OSObject *target,
                                                 void *reference)
{
	if (ivars->driver == nullptr) return kIOReturnNotReady;
	switch (selector) {
	case kFavorZplSelectorSendRaw: return SendRawSelector(ivars->driver, arguments);
	case kFavorZplSelectorStatus: return StatusSelector(ivars->driver, arguments);
	case kFavorZplSelectorReadStatus: return ReadStatusSelector(ivars->driver, arguments);
	default: return kIOReturnUnsupported;
	}
}
