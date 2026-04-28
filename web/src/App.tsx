import { Routes, Route, Navigate } from "react-router-dom";
import { AuthLoading, Authenticated, Unauthenticated } from "convex/react";
import LoginPage from "./pages/LoginPage";
import LibraryPage from "./pages/LibraryPage";
import ShopPage from "./pages/ShopPage";
import BookDetailPage from "./pages/BookDetailPage";
import ClaimPage from "./pages/ClaimPage";
import ReaderPage from "./pages/ReaderPage";
import AdminPage from "./pages/AdminPage";
import CheckoutSuccessPage from "./pages/CheckoutSuccessPage";
import AppShell from "./components/AppShell";

export default function App() {
  return (
    <>
      <AuthLoading>
        <div className="centered">Laden...</div>
      </AuthLoading>

      <Unauthenticated>
        <Routes>
          <Route path="/claim/:token" element={<ClaimPage />} />
          <Route path="/shop" element={<ShopPageWrap />} />
          <Route path="/book/:id" element={<BookDetailPageWrap />} />
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </Unauthenticated>

      <Authenticated>
        <AppShell>
          <Routes>
            <Route path="/" element={<Navigate to="/library" replace />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/shop" element={<ShopPage />} />
            <Route path="/book/:id" element={<BookDetailPage />} />
            <Route path="/read/:id" element={<ReaderPage />} />
            <Route path="/claim/:token" element={<ClaimPage />} />
            <Route path="/checkout/success" element={<CheckoutSuccessPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </AppShell>
      </Authenticated>
    </>
  );
}

function ShopPageWrap() {
  return (
    <AppShell>
      <ShopPage />
    </AppShell>
  );
}
function BookDetailPageWrap() {
  return (
    <AppShell>
      <BookDetailPage />
    </AppShell>
  );
}
