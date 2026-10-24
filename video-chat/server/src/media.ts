import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

// How a matched pair's audio and video travel.
//
// - "p2p": straight between the two browsers. The server never sees the
//   media, so it can't monitor or cut a call. Dev default only.
// - LiveKit: both browsers send media to a LiveKit server (an SFU) that we
//   run or rent. Every call is a LiveKit room we create, can watch, and can
//   end instantly for both sides, which processors and card networks expect
//   for live adult content.
export interface MediaRouter {
  // Opens a room for the call and returns what each participant needs to join it.
  openCall(callId: string, participants: { userId: string; displayName: string }[]): Promise<Map<string, JoinInfo>>;
  // Closes the room, disconnecting everyone in it. Safe to call more than once.
  closeCall(callId: string): Promise<void>;
}

export interface JoinInfo {
  url: string;
  token: string;
}

export function liveKitFromEnv(): MediaRouter | null {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;
  return liveKitRouter({ url, apiKey, apiSecret });
}

export function liveKitRouter(opts: { url: string; apiKey: string; apiSecret: string }): MediaRouter {
  const rooms = new RoomServiceClient(opts.url.replace(/^ws/, "http"), opts.apiKey, opts.apiSecret);
  return {
    async openCall(callId, participants) {
      // Room is created up front with a short empty timeout, so a room nobody
      // joins (or everyone leaves) cleans itself up.
      await rooms.createRoom({ name: callId, emptyTimeout: 30, maxParticipants: participants.length });
      const join = new Map<string, JoinInfo>();
      for (const p of participants) {
        const token = new AccessToken(opts.apiKey, opts.apiSecret, {
          identity: p.userId,
          name: p.displayName,
          // Only needs to last until they connect.
          ttl: "2m",
        });
        token.addGrant({ room: callId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false });
        join.set(p.userId, { url: opts.url, token: await token.toJwt() });
      }
      return join;
    },
    async closeCall(callId) {
      await rooms.deleteRoom(callId).catch(() => {});
    },
  };
}
