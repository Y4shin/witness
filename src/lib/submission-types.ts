import type { SubmissionType } from './api-types';

export interface FieldDef {
	key: string;
	label: string;
	placeholder?: string;
	required: boolean;
	/** If true, this field value is used as the archiveCandidateUrl */
	isArchiveUrl?: boolean;
}

export interface SubmissionTypeDef {
	value: SubmissionType;
	label: string;
	fields: FieldDef[];
}

export const SUBMISSION_TYPES: SubmissionTypeDef[] = [
	{
		value: 'WEBPAGE',
		label: 'Webpage',
		fields: [
			{ key: 'url', label: 'URL', placeholder: 'https://example.com/page', required: true, isArchiveUrl: true },
			{ key: 'notes', label: 'Notes', placeholder: 'Optional notes about this page', required: false }
		]
	},
	{
		value: 'YOUTUBE_VIDEO',
		label: 'YouTube Video',
		fields: [
			{ key: 'url', label: 'YouTube URL', placeholder: 'https://www.youtube.com/watch?v=...', required: true, isArchiveUrl: true },
			{ key: 'notes', label: 'Notes', placeholder: 'Optional notes', required: false }
		]
	},
	{
		value: 'INSTAGRAM_POST',
		label: 'Instagram Post',
		fields: [
			{ key: 'url', label: 'Post URL', placeholder: 'https://www.instagram.com/p/...', required: true, isArchiveUrl: true },
			{ key: 'notes', label: 'Notes', placeholder: 'Optional notes', required: false }
		]
	},
	{
		value: 'INSTAGRAM_STORY',
		label: 'Instagram Story',
		fields: [
			{ key: 'username', label: 'Username', placeholder: '@username', required: true },
			{ key: 'notes', label: 'Notes', placeholder: 'Description of the story (stories expire quickly)', required: false }
		]
	}
];

export function getTypeDef(type: SubmissionType): SubmissionTypeDef {
	return SUBMISSION_TYPES.find((t) => t.value === type) ?? SUBMISSION_TYPES[0];
}

export const SUBMISSION_TYPE_LABELS: Record<SubmissionType, string> = {
	WEBPAGE: 'Webpage',
	YOUTUBE_VIDEO: 'YouTube Video',
	INSTAGRAM_POST: 'Instagram Post',
	INSTAGRAM_STORY: 'Instagram Story'
};
