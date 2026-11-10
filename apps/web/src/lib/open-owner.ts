/** Asks a one-person server for the owner's session; true once the cookie is set. */
export async function requestOwnerSession(base = ""): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/auth/open`, {
      method: "POST",
      credentials: "include",
    });
    return response.ok;
  } catch {
    return false;
  }
}
