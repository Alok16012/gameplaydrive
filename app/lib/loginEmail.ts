// Supabase logins are email + password. Staff sign in with a username and players with their mobile number,
// so each maps to an internal address that never receives mail.
export const staffEmail = (username: string) => `u.${username.trim().toLowerCase()}@gamehub.invalid`;
export const playerEmail = (phone: string) => `p.${phone}@gamehub.invalid`;
