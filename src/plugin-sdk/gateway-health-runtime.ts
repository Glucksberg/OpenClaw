import { getHealthCache } from "../gateway/server/health-state.js";

/** Read the last gateway-owned health snapshot without recursively dispatching an RPC. */
export function readCachedGatewayHealth(): unknown {
  return getHealthCache();
}
