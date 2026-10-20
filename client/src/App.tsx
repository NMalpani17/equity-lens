import { Navigate, Route, Routes } from "react-router-dom";

import { LoginPage } from "@/components/auth/LoginPage";
import { ForgotPasswordPage } from "@/components/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "@/components/auth/ResetPasswordPage";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PrivacyPage } from "@/components/legal/PrivacyPage";
import { TermsPage } from "@/components/legal/TermsPage";
import { DashboardPage } from "@/components/DashboardPage";
import { AccountPage } from "@/components/AccountPage";
import { ChatPage } from "@/components/chat/ChatPage";
import { ReportsPage } from "@/components/reports/ReportsPage";
import { WatchlistPage } from "@/components/watchlist/WatchlistPage";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      {/* Public: readable without signing in. */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/watchlist"
        element={
          <ProtectedRoute>
            <WatchlistPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chat"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reports/:ticker?"
        element={
          <ProtectedRoute>
            <ReportsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/account"
        element={
          <ProtectedRoute>
            <AccountPage />
          </ProtectedRoute>
        }
      />
      {/* Unknown routes fall back to the dashboard (which redirects if signed out). */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
