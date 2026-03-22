/**
 * Per-project offline file cache settings, stored in localStorage.
 *
 * Settings are keyed per project so different projects can have
 * different cache configurations.
 */
import type { SubmissionType } from '$lib/api-types';

export interface OfflineFileSettings {
	enabled: boolean;
	/** Maximum total cache size in MB. 0 means no limit. */
	maxCacheMb: number;
	/** Only files from these submission types are cached. */
	allowedTypes: SubmissionType[];
}

const DEFAULTS: OfflineFileSettings = {
	enabled: false,
	maxCacheMb: 200,
	allowedTypes: []
};

function storageKey(projectId: string) {
	return `rt:offline-file-settings:${projectId}`;
}

export function loadOfflineFileSettings(projectId: string): OfflineFileSettings {
	try {
		const raw = localStorage.getItem(storageKey(projectId));
		if (!raw) return { ...DEFAULTS };
		return { ...DEFAULTS, ...JSON.parse(raw) } as OfflineFileSettings;
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveOfflineFileSettings(projectId: string, settings: OfflineFileSettings): void {
	localStorage.setItem(storageKey(projectId), JSON.stringify(settings));
}
