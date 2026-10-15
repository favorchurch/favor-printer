#ifndef FavorZplTransferGate_h
#define FavorZplTransferGate_h

#include <stdbool.h>
#include <stdint.h>

// Transfer gate shared by the dext (C++) and the Swift tests (through Bridging-Header.h). Plain C only.
//
// one transfer at a time (two user clients could otherwise interleave labels on the
// bulk OUT pipe), held through start-up, and closed for good when the dext stops so that no new transfer begins
// while Stop tears the pipes down. Zero-initialise. Lives here so the Swift tests can exercise it.
typedef struct {
	uint32_t busy;
	uint32_t closed;
	uint32_t pipesFreeable;   // set only by a Stop that drained the gate, never undone
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

// Stop: close the gate, then wait for a transfer in flight, calling `step` (abort pending I/O and sleep stepMs)
// between checks, for at most maxWaitMs. Returns true when the gate is drained and the caller owns it.
// FavorZplGateCanFreePipes turns true only then. A Stop that timed out leaves it false for good, even if the
// transfer ends later: the pipes are leaked rather than freed under a transfer.
static inline bool FavorZplGateCloseAndDrain(FavorZplGate *gate, uint32_t maxWaitMs, uint32_t stepMs,
                                             void (*step)(void *context), void *context)
{
	FavorZplGateClose(gate);
	bool drained = false;
	for (uint32_t waited = 0; !(drained = FavorZplGateTryDrain(gate)) && waited < maxWaitMs; waited += stepMs) {
		step(context);
	}
	if (drained) __atomic_store_n(&gate->pipesFreeable, 1, __ATOMIC_RELEASE);
	return drained;
}

static inline bool FavorZplGateCanFreePipes(const FavorZplGate *gate)
{
	return __atomic_load_n(&gate->pipesFreeable, __ATOMIC_ACQUIRE) != 0;
}

#endif
