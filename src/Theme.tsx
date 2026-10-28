import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(
  null,
);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  function apply(value: Theme) {
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
    setTheme(value);
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "leadsync.theme") {
        apply(
          event.newValue === "dark"
            ? "dark"
            : event.newValue === "light"
              ? "light"
              : matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light",
        );
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function toggle() {
    const value = theme === "dark" ? "light" : "dark";
    apply(value);
    try {
      localStorage.setItem("leadsync.theme", value);
    } catch {
      /* Theme still works when storage is unavailable. */
    }
  }
  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is required");
  return value;
}
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      className="ls-theme-toggle"
      role="switch"
      aria-label="Dark theme"
      aria-checked={theme === "dark"}
      title={
        theme === "dark" ? "Switch to Light theme" : "Switch to Dark theme"
      }
      onClick={toggle}
    >
      {theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      <span>{theme === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}
export function MfecBrand({ className = "" }: { className?: string }) {
  const { theme } = useTheme();
  return (
    <span className={`ls-mfec-brand ${className}`}>
      <img
        className={theme === "dark" ? "ls-mfec-white" : ""}
        src={`/images/mfec_${theme === "dark" ? "white_darktheme" : "black_whitetheme"}.png`}
        alt="MFEC"
      />
      <span>
        Lead<span>Sync</span>
      </span>
    </span>
  );
}
