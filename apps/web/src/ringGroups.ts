import type { Key } from './i18n/index.js'

/** The members an administrator typed (`101, 102 103`): extensions in their order, each once. */
export const parseMembers = (text: string): string[] => [...new Set(text.split(/[\s,;]+/).filter(Boolean))]

/** The Gateway's reasons for refusing a group (its error `code`), in the administrator's words. */
const CODE_KEY: Record<string, Key> = {
  GROUP_NUMBER: 'admin.groupNumberInvalid',
  GROUP_NUMBER_TAKEN: 'admin.groupNumberTaken',
  GROUP_EXISTS: 'admin.groupExists',
  GROUP_NAME: 'admin.groupNameInvalid',
  GROUP_MEMBERS: 'admin.groupMembersInvalid',
  GROUP_MEMBER_NOT_EXTENSION: 'admin.groupMemberNotExtension',
  SYNC_RUNNING: 'admin.groupSyncRunning'
}

export const groupRefusalKey = (err: unknown): Key | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? CODE_KEY[code] : undefined
}
