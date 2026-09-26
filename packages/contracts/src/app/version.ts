/**
 * App protocol version — bumped on any wire-incompatible change.
 * Handshake: client sends it in `session.hello`; a mismatch returns the
 * typed `protocol_version_mismatch` error naming which side to update.
 */
export const APP_PROTOCOL_VERSION = 1;
