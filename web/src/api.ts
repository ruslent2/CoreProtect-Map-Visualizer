import type { BBox, Filters } from './state';
import { filtersToQuery } from './state';

// Структуры данных, получаемые от API CoreProtect.
export interface CpEvent {
	src: string;
	rowid_src: number;
	time: number;
	nick: string | null;
	uuid: string | null;
	world: string;
	x: number;
	y: number;
	z: number;
	material: string | null;
	amount: number | null;
	action: number;
	rolled_back: number;
}

export interface Chunk {
	cx: number;
	cz: number;
	cnt: number;
	tmin: number;
	tmax: number;
	users: number;
	dominant: {
		nick: string | null;
		uuid: string | null;
		src: string;
		action: number;
	} | null;
}

export interface SourceSnapshot {
	block: number;
	container: number;
	item: number;
}

export interface CoreProtectTilesConfig {
	tileSize: number;
	maxConcurrentRequests: number;
	detailPageSize: number;
	maxTextureSize: number;
}

export interface ApiConfig {
	defaultLimit: number;
	coreProtectTiles: CoreProtectTilesConfig;
	bluemap: Record<string, unknown>;
}

export interface AuthUser {
	id: string;
	username: string;
	avatar: string | null;
	role: 'admin' | 'moderator';
}

export interface BlockedUser {
	discordId: string;
	addedBy: string;
	createdAt: number;
}

export interface QueryPlanResult {
	strategy: 'all' | 'overview-and-detail';
	threshold: number;
	countAtLeast: number;
	totalExact: boolean;
	total?: number;
	bounds: BBox | null;
	snapshot: SourceSnapshot;
	elapsedMs: number;
}

export interface QueryPageResult {
	count: number;
	hasMore: boolean;
	nextCursor: string | null;
	snapshot: SourceSnapshot;
	truncated: boolean;
	elapsedMs: number;
	events: CpEvent[];
	bbox: BBox | null;
}

export interface AggregateResult {
	chunks: Chunk[];
	occupiedTiles: {
		tx: number;
		tz: number;
		cnt: number;
		tmin: number;
		tmax: number;
	}[];
	players: {
		nick: string | null;
		uuid: string | null;
	}[];
	total: number;
	temporal: {
		tmin: number;
		tmax: number;
		users: number;
	} | null;
	elapsedMs: number;
	snapshot: SourceSnapshot;
	bbox: BBox | null;
}

export interface MetaData {
	worlds: {
		id: number;
		world: string;
	}[];
	users: {
		id: number;
		nick: string;
		uuid: string | null;
	}[];
	materials: string[];
	actions: {
		id: string;
		label: string;
		src: string;
		action: number;
	}[];
}

// Выполняет HTTP-запрос и преобразует успешный ответ в JSON.
async function getJson<T>(
	path: string,
	signal?: AbortSignal,
	method = 'GET',
): Promise<T> {
	const response = await fetch(path, { signal, method });

	if (!response.ok) {
		throw new Error(
			(await response.text()) || `${response.status} ${response.statusText}`,
		);
	}

	return response.json() as Promise<T>;
}

/** Повертає поточного користувача або null, якщо сесія відсутня. */
export async function apiAuthMe(): Promise<AuthUser | null> {
	const response = await fetch('/api/auth/me');
	if (response.status === 401) return null;
	if (!response.ok) throw new Error((await response.text()) || response.statusText);
	return response.json() as Promise<AuthUser>;
}

export async function apiLogout() {
	await fetch('/api/auth/logout', { method: 'POST' });
}

export function apiBlacklist() {
	return getJson<{ users: BlockedUser[] }>('/api/admin/blacklist');
}

export async function apiBlockUser(discordId: string) {
	const response = await fetch('/api/admin/blacklist', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ discordId }),
	});
	if (!response.ok) throw new Error((await response.text()) || response.statusText);
}

export function apiUnblockUser(discordId: string) {
	return getJson<{ removed: boolean }>(`/api/admin/blacklist/${encodeURIComponent(discordId)}`, undefined, 'DELETE');
}

// Добавляет фильтры к дополнительным параметрам строки запроса.
function query(filters: Filters, extra: Record<string, string> = {}) {
	return filtersToQuery(filters, extra);
}

// Методы для получения конфигурации и справочных данных.
export function apiConfig(signal?: AbortSignal) {
	return getJson<ApiConfig>('/api/config', signal);
}

export function apiMeta(signal?: AbortSignal) {
	return getJson<MetaData>('/api/meta', signal);
}

export function apiRefreshMeta(signal?: AbortSignal) {
	return getJson<MetaData>('/api/meta/refresh', signal, 'POST');
}

// Планирует выборку с необязательным снимком источников данных.
export function apiQueryPlan(
	filters: Filters,
	snapshot?: SourceSnapshot,
	signal?: AbortSignal,
) {
	return getJson<QueryPlanResult>(
		`/api/query-plan?${query(
			filters,
			snapshot ? { snapshot: JSON.stringify(snapshot) } : {},
		)}`,
		signal,
	);
}

// Загружает страницу событий, при необходимости ограниченную тайлом карты.
export function apiQueryPage(
	filters: Filters,
	options: {
		snapshot: SourceSnapshot;
		cursor?: string | null;
		pageSize: number;
		tile?: {
			xMin: number;
			xMaxExclusive: number;
			zMin: number;
			zMaxExclusive: number;
		};
	},
	signal?: AbortSignal,
) {
	const extra: Record<string, string> = {
		snapshot: JSON.stringify(options.snapshot),
		pageSize: String(options.pageSize),
	};

	if (options.cursor) {
		extra.cursor = options.cursor;
	}

	if (options.tile) {
		Object.assign(
			extra,
			Object.fromEntries(
				Object.entries(options.tile).map(([key, value]) => [key, String(value)]),
			),
		);
	}

	return getJson<QueryPageResult>(`/api/query?${query(filters, extra)}`, signal);
}

// Получает агрегированные данные для отображения на карте.
export function apiAggregate(
	filters: Filters,
	snapshot: SourceSnapshot,
	tileSize: number,
	signal?: AbortSignal,
) {
	return getJson<AggregateResult>(
		`/api/aggregate?${query(filters, {
			snapshot: JSON.stringify(snapshot),
			tileSize: String(tileSize),
		})}`,
		signal,
	);
}

// Получает отдельное событие и события рядом с ним.
export function apiEvent(src: string, rowid: number, signal?: AbortSignal) {
	return getJson<{ event: CpEvent; nearby: CpEvent[] }>(
		`/api/event/${encodeURIComponent(src)}/${rowid}`,
		signal,
	);
}

// Получает состояние синхронизации сервера.
export function apiSyncStatus(signal?: AbortSignal) {
	return getJson<unknown>('/api/sync/status', signal);
}
