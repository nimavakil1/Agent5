import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './shell/App';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import AgentStudio from './pages/AgentStudio';
import Orchestrator from './pages/Orchestrator';
import AdminUsers from './pages/AdminUsers';
import Profile from './pages/Profile';
import {
  AccountingDashboard,
  InvoiceQueue,
  AccountingChat,
  Reports as AccountingReports,
  Settings as AccountingSettings,
} from './pages/accounting';
import { AuthProvider } from './shell/auth';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'products', element: <Products /> },
      { path: 'agent-studio', element: <AgentStudio /> },
      { path: 'orchestrator', element: <Orchestrator /> },
      { path: 'admin/users', element: <AdminUsers /> },
      { path: 'profile', element: <Profile /> },
      // Accounting Agent
      { path: 'accounting', element: <AccountingDashboard /> },
      { path: 'accounting/invoices', element: <InvoiceQueue /> },
      { path: 'accounting/chat', element: <AccountingChat /> },
      { path: 'accounting/reports', element: <AccountingReports /> },
      { path: 'accounting/settings', element: <AccountingSettings /> },
    ]
  }
]);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </React.StrictMode>
);

