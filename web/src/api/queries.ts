import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { CreateMonitorInput, MonitorRevision } from "../types";

export const queryKeys = {
  monitors: ["monitors"] as const,
  monitor: (id: string) => ["monitor", id] as const,
  execution: (id: string) => ["execution", id] as const,
  review: (monitorId: string, revisionId: string) => ["review", monitorId, revisionId] as const,
  status: ["system", "status"] as const,
  metrics: ["system", "metrics"] as const,
};

export function useMonitors() {
  return useQuery({ queryKey: queryKeys.monitors, queryFn: api.listMonitors, refetchInterval: 30_000 });
}

export function useMonitor(id: string) {
  return useQuery({
    queryKey: queryKeys.monitor(id),
    queryFn: () => api.getMonitor(id),
    enabled: Boolean(id),
  });
}

export function useCreateMonitor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMonitorInput) => api.createMonitor(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.monitors }),
  });
}

export function useUpdateMonitor(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.updateMonitor(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monitor(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.monitors });
    },
  });
}

export function useConfirmMonitor(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ revision, condition }: { revision: MonitorRevision; condition?: Parameters<typeof api.confirmMonitor>[2] }) =>
      api.confirmMonitor(id, revision, condition),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monitor(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.monitors });
    },
  });
}

export function useRunCheck(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.runCheck(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.monitor(id) }),
  });
}

export function useExecution(id: string) {
  return useQuery({
    queryKey: queryKeys.execution(id),
    queryFn: () => api.getExecution(id),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "queued" || state === "running" ? 2_000 : false;
    },
  });
}

export function useReview(monitorId: string, revisionId: string) {
  return useQuery({
    queryKey: queryKeys.review(monitorId, revisionId),
    queryFn: () => api.getReview(monitorId, revisionId),
    enabled: Boolean(monitorId && revisionId),
  });
}

export function useReviewDecision(monitorId: string, revisionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: "accept" | "reject") => api.reviewRevision(monitorId, revisionId, decision),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.monitor(monitorId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.monitors });
    },
  });
}

export function useServiceStatus() {
  return useQuery({ queryKey: queryKeys.status, queryFn: api.getServiceStatus, refetchInterval: 15_000 });
}

export function useMetrics(enabled = true) {
  return useQuery({ queryKey: queryKeys.metrics, queryFn: api.getMetrics, enabled, refetchInterval: 15_000 });
}
