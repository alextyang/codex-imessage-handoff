// imsg's injected bridge can wait up to 150 seconds for a private send on
// macOS 26. Keep the helper timeout above that bridge window, then give the
// controller enough additional time to receive and durably acknowledge the
// helper result. Ordinary control and status requests keep their shorter,
// transport-local timeouts.
export const IMSG_UPSTREAM_BRIDGE_SEND_TIMEOUT_MS = 150_000;
export const IMSG_RPC_SEND_TIMEOUT_MS = 180_000;
export const IMSG_IPC_MUTATION_TIMEOUT_MS = 210_000;
