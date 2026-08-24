import type { IncomingMessage } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { ToolsDeps } from './tools.js';
/** Re-exported so index.ts builds routes without importing dsh-host-webserver. */
export type Route = WebRoute;
export interface RoutesDeps extends ToolsDeps {
    /**
     * Native local-directory picker (adapted from the ctx directoryPicker
     * service by index.ts). Absent → /local-pick answers 400.
     */
    pickDirectory?: () => Promise<string | null>;
}
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export declare function isIPv4Loopback(v4: string): boolean;
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export declare function isLoopbackAddress(address: string | undefined): boolean;
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
export declare function isLoopbackHostname(hostname: string): boolean;
/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. The socket address is
 * authoritative; X-Forwarded-For is never trusted.
 */
export declare function isLoopbackRequest(request: IncomingMessage): boolean;
/** Build every /api/dsh-rw route (exact paths). */
export declare function makeRoutes(deps: RoutesDeps): Route[];
