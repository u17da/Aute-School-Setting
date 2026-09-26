import { z } from 'zod';

export const OnOffSchema = z.enum(['ON', 'OFF']);
export const StorageValueSchema = z.enum(['ON', 'OFF', 'TEACHERS_ONLY']);
export const DirectMessageValueSchema = z.enum(['ON', 'OFF', 'STUDENT_TO_STUDENT_DISABLED']);
export const PermissionValueSchema = z.enum(['ALLOW', 'DENY']);
export const DisplayValueSchema = z.enum(['SHOW', 'HIDE']);

export const SchoolTargetSchema = z.object({
  schoolCode: z.string().min(1, '学校コードは必須です'),
  schoolName: z.string().min(1, '学校名は必須です')
});

export const RequestedSettingsSchema = z.object({
  storage: StorageValueSchema.nullable().optional(),
  timelineChannel: OnOffSchema.nullable().optional(),
  directMessage: DirectMessageValueSchema.nullable().optional(),
  parentDirectMessage: OnOffSchema.nullable().optional(),
  allChannel: OnOffSchema.nullable().optional(),
  parentChannel: OnOffSchema.nullable().optional(),
  attendance: OnOffSchema.nullable().optional(),
  contactBook: OnOffSchema.nullable().optional(),
  mentalHealth: OnOffSchema.nullable().optional(),
  otherSchoolLog: PermissionValueSchema.nullable().optional(),
  studentPasswordChange: DisplayValueSchema.nullable().optional()
}).strict();

export const SchoolConfigFileSchema = z.object({
  school: SchoolTargetSchema,
  settings: RequestedSettingsSchema
});

export type SchoolConfigFileType = z.infer<typeof SchoolConfigFileSchema>;
