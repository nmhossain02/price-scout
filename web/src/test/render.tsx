import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";

export function renderPage(element: ReactElement, route = "/") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    queryClient,
    ...render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[route]}>{element}</MemoryRouter></QueryClientProvider>),
  };
}
