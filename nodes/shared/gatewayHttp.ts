/**
 * Shared HTTP and polling helpers for Ordigovernance gateway nodes.
 *
 * Errors are thrown as GatewayHttpError instances carrying the parsed
 * response body, so callers can read structured fields (e.g. the
 * conflicting run id inside a 409 detail) instead of regexing the
 * rendered message. The message itself still follows the
 * "[status] body-snippet" convention for readable n8n UI surfacing.
 */

export interface GatewayCredentials {
	baseUrl: string;
	token: string;
}

export interface GatewayRequestOptions {
	method: 'GET' | 'POST';
	path: string;
	body?: Record<string, unknown>;
	timeoutMs?: number;
}

export class GatewayHttpError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;

	constructor(method: string, path: string, status: number, body: Record<string, unknown>) {
		const text = JSON.stringify(body);
		super(`gateway request ${method} ${path} failed [${status}]: ${text.slice(0, 500)}`);
		this.name = 'GatewayHttpError';
		this.status = status;
		this.body = body;
	}
}

const DEFAULT_TIMEOUT_MS = 30000;

export async function gatewayRequest<T extends Record<string, unknown>>(
	credentials: GatewayCredentials,
	options: GatewayRequestOptions,
): Promise<T> {
	const baseUrl = credentials.baseUrl.replace(/\/+$/, '');
	const url = `${baseUrl}${options.path}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, {
			method: options.method,
			headers: {
				Authorization: `Bearer ${credentials.token}`,
				'Content-Type': 'application/json',
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: controller.signal,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		// Include the base URL: the classic n8n pitfall is curling n8n
		// itself (:5678) instead of the gateway (:8180), and the URL is
		// what names that mistake immediately.
		throw new Error(`gateway unreachable at ${baseUrl}: ${reason}`);
	} finally {
		clearTimeout(timeout);
	}

	const text = await response.text();
	if (!response.ok) {
		let body: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === 'object' && parsed !== null) {
				body = parsed as Record<string, unknown>;
			}
		} catch {
			body = { detail: text };
		}
		throw new GatewayHttpError(options.method, options.path, response.status, body);
	}
	if (!text) return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(
			`gateway request ${options.method} ${options.path} returned a non-JSON response`,
		);
	}
}

export interface GatewaySseFrame {
	type: string;
	[key: string]: unknown;
}

/**
 * POST a request and consume the response as an SSE frame stream.
 *
 * Each yielded value is one parsed JSON frame from a ``data:`` line.
 * The timeout is an IDLE timeout (reset on every received chunk), so
 * long streams are only killed by a stalled connection, never by a
 * fixed total budget. Non-2xx responses throw GatewayHttpError with
 * the same convention as gatewayRequest.
 */
export async function* gatewaySseStream(
	credentials: GatewayCredentials,
	options: { path: string; body?: Record<string, unknown>; timeoutMs?: number },
): AsyncGenerator<GatewaySseFrame> {
	const baseUrl = credentials.baseUrl.replace(/\/+$/, '');
	const url = `${baseUrl}${options.path}`;
	const controller = new AbortController();
	const idleMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timer = setTimeout(() => controller.abort(), idleMs);
	const resetIdle = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(), idleMs);
	};

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${credentials.token}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: controller.signal,
		});
	} catch (error) {
		clearTimeout(timer);
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`gateway unreachable at ${baseUrl}: ${reason}`);
	}

	if (!response.ok) {
		clearTimeout(timer);
		const text = await response.text();
		let body: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === 'object' && parsed !== null) {
				body = parsed as Record<string, unknown>;
			}
		} catch {
			body = { detail: text };
		}
		throw new GatewayHttpError('POST', options.path, response.status, body);
	}
	if (!response.body) {
		clearTimeout(timer);
		throw new Error(`gateway SSE stream ${options.path} returned no body`);
	}

	try {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			resetIdle();
			buffer += decoder.decode(value, { stream: true });
			let separator = buffer.indexOf('\n\n');
			while (separator >= 0) {
				const rawFrame = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				const frame = parseSseFrame(rawFrame);
				if (frame) yield frame;
				separator = buffer.indexOf('\n\n');
			}
		}
	} finally {
		clearTimeout(timer);
	}
}

function parseSseFrame(rawFrame: string): GatewaySseFrame | null {
	for (const line of rawFrame.split('\n')) {
		if (!line.startsWith('data:')) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === '[DONE]') return null;
		try {
			const parsed: unknown = JSON.parse(payload);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				return parsed as GatewaySseFrame;
			}
		} catch {
			// Skip malformed frames: SSE comments/keepalives never fail the stream.
		}
	}
	return null;
}

export interface PollOptions {
	intervalMs: number;
	timeoutMs: number;
}

export async function pollUntil<T>(
	fetchOnce: () => Promise<T>,
	isTerminal: (value: T) => boolean,
	options: PollOptions,
	describe: string,
): Promise<T> {
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		const value = await fetchOnce();
		if (isTerminal(value)) return value;
		if (Date.now() >= deadline) {
			throw new Error(`${describe} did not reach a terminal state within ${options.timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
	}
}