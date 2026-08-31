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
        line: "var(--cf-border)",
        accent: "var(--cf-accent)",
        "accent-fg": "var(--cf-accent-fg)",
        danger: "var(--cf-danger)",
        success: "var(--cf-success)",
      },
      fontSize: {
        base: "14px",
        code: "13px",
      },
      borderRadius: {
        window: "16px",
        input: "14px",
        btn: "9px",
      },
    },
  },
  plugins: [],
};
