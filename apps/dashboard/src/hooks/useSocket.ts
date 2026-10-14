"use client";

import { useEffect } from "react";
import { io, type Socket } from "socket.io-client";

// ---------------------------------------------------------------------------
// Singleton socket instance — one connection for the entire app lifetime
// ---------------------------------------------------------------------------

let _socket: Socket | null = null;

export function getSocket(): Socket | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (!_socket) {
    const url = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
    _socket = io(url, {
      withCredentials: true,
      transports: ["websocket", "polling"],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
  }
  return _socket;
}

/**
 * Ends the connection. Called on logout: the connection was authenticated as
 * the user who just left, so it must not be reused by whoever logs in next in
 * this tab, and its joined rooms must stop streaming (#64).
 */
export function disconnectSocket(): void {
  _socket?.disconnect();
}

/**
 * Opens a fresh connection under the current session cookie. Called after a
 * successful login/registration, because a socket the server closed (or that
 * was closed on logout) does not reconnect on its own.
 */
export function reconnectSocket(): void {
  const socket = getSocket();
  if (!socket) return;
  if (socket.connected) socket.disconnect();
  socket.connect();
}

/**
 * Returns the singleton Socket.io client.
 * Connects automatically and maintains connection.
 */
export function useSocket(): Socket | null {
  const socket = getSocket();

  useEffect(() => {
    if (socket && !socket.connected) {
      socket.connect();
    }
  }, [socket]);

  return socket;
}

