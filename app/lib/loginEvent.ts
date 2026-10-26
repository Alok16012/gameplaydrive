import { supabase } from "./supabase";

// Tell the server which IP this account is using (for the Admin console's same-IP alerts). Called on sign-in and
// whenever a saved session opens the app; fire-and-forget, never blocks or fails the caller.
export async function recordLogin() {
  try {
    const { data } = await supabase().auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch("/api/login-event", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  } catch {
    // ignore
  }
}

/** Mark this account as online every minute while the app is open and on screen (Online / last online in the admin
 *  console, migration 100). Returns a cleanup function. */
export function keepOnline(): () => void {
  const touch = () => {
    if (document.visibilityState === "visible") void supabase().rpc("touch_seen").then(() => {}, () => {});
  };
  touch();
  const t = setInterval(touch, 60_000);
  document.addEventListener("visibilitychange", touch);
  return () => { clearInterval(t); document.removeEventListener("visibilitychange", touch); };
}
