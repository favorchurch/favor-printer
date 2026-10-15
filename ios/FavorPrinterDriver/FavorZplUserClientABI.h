#ifndef FavorZplUserClientABI_h
#define FavorZplUserClientABI_h

// User-client ABI shared by the dext (C++) and the app (Swift, through Bridging-Header.h).
// Plain C only. Selector numbers and scalar layouts live here and nowhere else.
//
// Every scalar is a uint64_t. IOReturn values travel as the low 32 bits (cast back with Int32(truncatingIfNeeded:)).

#include <stdbool.h>
#include <stdint.h>

enum {
	// struct in:  raw bytes for the bulk OUT endpoint, 1...kFavorZplMaxSendBytes.
	// scalar out: FavorZplSendResult layout (kFavorZplSendResultCount scalars).
	// The call itself succeeds whenever the dext attempted USB I/O, so bytesWritten survives a USB failure;
	// ioReturn carries the USB result. kIOReturnNotReady means no I/O was attempted (OUT pipe not ready).
	kFavorZplSelectorSendRaw = 0,

	// no input.
	// scalar out: FavorZplStatusField layout (kFavorZplStatusFieldCount scalars).
	// struct out: the device serial string as UTF-8 bytes, 0...kFavorZplMaxSerialBytes (empty when the
	// descriptor has none).
	kFavorZplSelectorStatus = 1,

	// scalar in:  [timeoutMs] for the first transfer (clamped to 1...kFavorZplMaxReadTimeoutMs).
	// scalar out: FavorZplReadResult layout (kFavorZplReadResultCount scalars).
	// struct out: bytes read, up to kFavorZplMaxReadBytes. The call fails with kIOReturnNotFound when the interface
	// has no bulk IN endpoint. A USB failure with no bytes read is reported in ioReturn with an empty struct.
	kFavorZplSelectorReadStatus = 2,
};

enum {
	kFavorZplSendResultBytesWritten = 0,
	kFavorZplSendResultIOReturn = 1,
	kFavorZplSendResultCount = 2,
};

enum {
	kFavorZplStatusStage = 0,
	kFavorZplStatusError = 1,
	kFavorZplStatusBulkOutAddress = 2,
	kFavorZplStatusBulkInAddress = 3,   // 0 when the interface has no usable bulk IN endpoint
	kFavorZplStatusFieldCount = 4,
};

enum {
	kFavorZplReadResultBytesRead = 0,
	kFavorZplReadResultIOReturn = 1,
	kFavorZplReadResultCount = 2,
};

// Start-up stages recorded by the dext. The dext registers its service before stage 2 and never fails after that,
// so the stage reached and the error at that stage are always readable.
enum {
	kFavorZplStageSuperStart = 1,
	kFavorZplStageProviderCast = 2,
	kFavorZplStageRetained = 3,
	kFavorZplStageOpening = 4,
	kFavorZplStageOpened = 5,
	kFavorZplStageDescriptorRead = 6,
	kFavorZplStageBulkOutFound = 7,
	kFavorZplStageReady = 8,   // bulk OUT pipe is usable
};

enum {
	kFavorZplMaxSendBytes = 256 * 1024,
	kFavorZplMaxReadBytes = 1024,
	kFavorZplMaxReadTimeoutMs = 10000,
	kFavorZplMaxSerialBytes = 64,
};

// Transfer gate in the dext: one transfer at a time (two user clients could otherwise interleave labels on the
// bulk OUT pipe), held through start-up, and closed for good when the dext stops so that no new transfer begins
// while Stop tears the pipes down. Zero-initialise. Lives here so the Swift tests can exercise it.
typedef struct {
	uint32_t busy;
	uint32_t closed;
} FavorZplGate;

static inline bool FavorZplGateTryAcquire(FavorZplGate *gate)
{
	if (__atomic_exchange_n(&gate->busy, 1, __ATOMIC_ACQUIRE) != 0) return false;
	// Checked after taking busy so that Close cannot slip in between: Stop then never waits on a transfer that
	// did not start.
	if (__atomic_load_n(&gate->closed, __ATOMIC_ACQUIRE)) {
		__atomic_store_n(&gate->busy, 0, __ATOMIC_RELEASE);
		return false;
	}
	return true;
}

static inline bool FavorZplGateIsClosed(const FavorZplGate *gate)
{
	return __atomic_load_n(&gate->closed, __ATOMIC_ACQUIRE) != 0;
}

static inline void FavorZplGateRelease(FavorZplGate *gate)
{
	__atomic_store_n(&gate->busy, 0, __ATOMIC_RELEASE);
}

static inline void FavorZplGateClose(FavorZplGate *gate)
{
	__atomic_store_n(&gate->closed, 1, __ATOMIC_RELEASE);
}

// For Stop, after FavorZplGateClose: true once no transfer is in flight. The caller then owns the gate.
static inline bool FavorZplGateTryDrain(FavorZplGate *gate)
{
	return __atomic_exchange_n(&gate->busy, 1, __ATOMIC_ACQUIRE) == 0;
}

#endif
