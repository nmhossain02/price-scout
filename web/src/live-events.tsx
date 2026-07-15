import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { eventStreamUrl } from "./api/client";
import { queryKeys } from "./api/queries";
import type { SystemEvent } from "./types";

type ConnectionState = "connecting" | "live" | "offline";

interface LiveEventsValue {
  events: SystemEvent[];
  connection: ConnectionState;
}

const LiveEventsContext = createContext<LiveEventsValue>({ events: [], connection: "connecting" });

function decodeEvent(message: MessageEvent<string>): SystemEvent {
  try {
    const parsed = JSON.parse(message.data) as Partial<SystemEvent> & { at?: string };
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data : undefined;
    return {
      id: parsed.id ?? crypto.randomUUID(),
      type: parsed.type ?? message.type ?? "system.event",
      occurredAt: parsed.occurredAt ?? parsed.at ?? new Date().toISOString(),
      monitorId: parsed.monitorId ?? (typeof data?.monitorId === "string" ? data.monitorId : undefined),
      executionId: parsed.executionId ?? (typeof data?.executionId === "string" ? data.executionId : undefined),
      message: parsed.message ?? (typeof data?.message === "string" ? data.message : undefined),
      data,
    };
  } catch {
    return {
      id: crypto.randomUUID(),
      type: message.type || "system.event",
      occurredAt: new Date().toISOString(),
      message: message.data,
    };
  }
}

export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const queryClient = useQueryClient();
  const retryTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!("EventSource" in window)) {
      setConnection("offline");
      return;
    }

    let source: EventSource | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      setConnection("connecting");
      source = new EventSource(eventStreamUrl);
      source.onopen = () => setConnection("live");
      const handleMessage = (message: MessageEvent<string>) => {
        const event = decodeEvent(message);
        setEvents((current) => [event, ...current].slice(0, 100));
        queryClient.invalidateQueries({ queryKey: queryKeys.monitors });
        if (event.monitorId) queryClient.invalidateQueries({ queryKey: queryKeys.monitor(event.monitorId) });
        if (event.executionId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.execution(event.executionId) });
        }
      };
      source.onmessage = handleMessage;
      source.addEventListener("update", (event) => handleMessage(event as MessageEvent<string>));
      source.onerror = () => {
        setConnection("offline");
        source?.close();
        retryTimer.current = window.setTimeout(connect, 5_000);
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
    };
  }, [queryClient]);

  const value = useMemo(() => ({ events, connection }), [events, connection]);
  return <LiveEventsContext.Provider value={value}>{children}</LiveEventsContext.Provider>;
}

export function useLiveEvents() {
  return useContext(LiveEventsContext);
}
