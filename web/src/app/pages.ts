/** The Treasury's pages: their addresses (kept from the prototype, so saved links work) and titles. */
export const PAGES = {
  "/": "Overview",
  "/automations": "Strategy",
  "/follow/run": "Runs",
  "/funding": "Balances & funding",
  "/policy": "Policy & grants",
  "/demo": "Guided walkthrough",
  "/activity": "Operation status",
} as const;
export type Page = keyof typeof PAGES;
export const pageTitle = (path: string) => PAGES[(path.replace(/\/$/, "") || "/") as Page] ?? PAGES["/"];
