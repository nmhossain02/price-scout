import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./pages/DashboardPage";
import { ExecutionPage } from "./pages/ExecutionPage";
import { MonitorDetailPage } from "./pages/MonitorDetailPage";
import { NewMonitorPage } from "./pages/NewMonitorPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OperationsPage } from "./pages/OperationsPage";
import { ReviewPage } from "./pages/ReviewPage";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="monitors/new" element={<NewMonitorPage />} />
        <Route path="monitors/:monitorId" element={<MonitorDetailPage />} />
        <Route path="monitors/:monitorId/reviews/:revisionId" element={<ReviewPage />} />
        <Route path="executions/:executionId" element={<ExecutionPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
