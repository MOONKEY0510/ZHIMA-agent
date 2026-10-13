/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--cf-bg)",
        panel: "var(--cf-panel)",
        "panel-2": "var(--cf-panel-2)",
        ink: "var(--cf-text)",
        "ink-2": "var(--cf-text-2)",
        "ink-3": "var(--cf-text-3)",
        line: "var(--cf-border)",
        accent: "var(--cf-accent)",
        "accent-fg": "var(--cf-accent-fg)",
        danger: "var(--cf-danger)",
        success: "var(--cf-success)",
        hover: "var(--cf-hover)",
      },
      fontFamily: {
        serif: ["var(--cf-font-serif)"],
      },
      fontSize: {
        base: "14px",
        code: "13px",
        // Semantic scale (Claude-style redesign): use these in new/updated
        // code instead of arbitrary `text-[Npx]` values.
        meta: ["12px", "18px"],
        ui: ["13px", "20px"],
        body: ["15px", "26px"],
        title: ["18px", "26px"],
        display: ["28px", "36px"],
      },
      borderRadius: {
        window: "16px",
        input: "14px",
        btn: "8px",
        menu: "12px",
        bubble: "18px",
        composer: "20px",
      },
      boxShadow: {
        composer: "0 1px 2px rgb(0 0 0 / 4%), 0 4px 16px rgb(0 0 0 / 5%)",
        "composer-focus": "0 1px 2px rgb(0 0 0 / 5%), 0 6px 24px rgb(0 0 0 / 8%)",
        menu: "0 8px 28px rgb(0 0 0 / 12%), 0 0 0 1px var(--cf-border)",
      },
    },
  },
  plugins: [],
};
