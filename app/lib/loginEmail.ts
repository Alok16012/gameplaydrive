// Supabase logins are email + password. Staff sign in with a username; a player's login is their mobile number
// if they have one, otherwise their username. Each maps to an internal address that never receives mail.
export const staffEmail = (username: string) => `u.${username.trim().toLowerCase()}@gamehub.invalid`;
export const playerEmail = (phone: string) => `p.${phone}@gamehub.invalid`;

/** The auth email behind an account, or null if it has nothing to sign in with. */
export const loginEmail = (p: { role: string; phone: string | null; username: string | null }) =>
  p.role === "player"
    ? p.phone ? playerEmail(p.phone) : p.username ? staffEmail(p.username) : null
    : p.username ? staffEmail(p.username) : null;
