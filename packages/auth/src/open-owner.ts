import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

export interface OpenOwner {
  email: string;
  name: string;
}

/**
 * Server-only: the router never exposes it. The API calls it, after checking who is asking, to
 * open a session as the deployment's single owner, creating the account on first use.
 */
export function openOwner(owner: OpenOwner): BetterAuthPlugin {
  return {
    id: "open-owner",
    endpoints: {
      openOwner: createAuthEndpoint(
        "/open",
        { method: "POST", metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const adapter = ctx.context.internalAdapter;
          let user = (await adapter.findUserByEmail(owner.email))?.user;
          if (!user) {
            // Concurrent first calls: the loser finds the winner's account.
            user = await adapter
              .createUser(
                { email: owner.email, name: owner.name, emailVerified: true },
                { method: "open-owner" },
              )
              .catch(async (error: unknown) => {
                const created = (await adapter.findUserByEmail(owner.email))?.user;
                if (!created) throw error;
                return created;
              });
          }
          const session = await adapter.createSession(user.id, false);
          if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "No session" });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({
            token: session.token,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              image: user.image ?? null,
              emailVerified: user.emailVerified,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            },
          });
        },
      ),
    },
  };
}
