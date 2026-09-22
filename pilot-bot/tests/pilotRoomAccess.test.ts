import { describe, it, expect } from 'vitest';
import { isPilotRoomParticipant } from '../supabase/functions/_shared/pilotRoomAccess';
describe('pilot room participation', () => {
  it.each(['creator', 'administrator', 'member'])('allows %s', status => expect(isPilotRoomParticipant({status})).toBe(true));
  it('allows a restricted member only while still in the room', () => {
    expect(isPilotRoomParticipant({status:'restricted',is_member:true})).toBe(true);
    expect(isPilotRoomParticipant({status:'restricted',is_member:false})).toBe(false);
  });
  it.each(['left','kicked','restricted','unknown',''])('rejects %s', status => expect(isPilotRoomParticipant({status})).toBe(false));
  it('fails closed on missing membership', () => expect(isPilotRoomParticipant(null)).toBe(false));
});
