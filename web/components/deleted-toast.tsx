"use client";

import { useEffect, useState } from "react";

/**
 * One-shot confirmation banner shown after a session is deleted and the user
 * is redirected to the list with `?deleted=1`. Clears the query param on mount
 * (so a refresh doesn't re-show it) and auto-dismisses after a few seconds.
 */
export function DeletedToast() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Strip the query param without a navigation/refresh.
    const url = new URL(window.location.href);
    if (url.searchParams.has("deleted")) {
      url.searchParams.delete("deleted");
      window.history.replaceState({}, "", url.toString());
    }
    const t = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  return (
    <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
      Session deleted. Its events and replay artifacts were removed.
    </div>
  );
}
