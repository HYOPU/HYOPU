/** Only current participants of an explicitly allowed room may operate the bot. */
export function isPilotRoomParticipant(member: { status?: string; is_member?: boolean } | null | undefined): boolean {
  return !!member && (['creator', 'administrator', 'member'].includes(member.status ?? '')
    || (member.status === 'restricted' && member.is_member === true));
}
