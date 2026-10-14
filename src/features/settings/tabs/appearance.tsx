import { useRef, useState } from "react";
import {
  ImageIcon,
} from "lucide-react";
import { useSettingsStore, AVATAR_COLORS, type AvatarShape } from "../../../stores/settings-store";
import type { ThemeMode } from "../../../types";
import { DIAGRAM_STYLE_OPTIONS } from "../../../lib/mermaid-theme";
import { SettingsSection, FormRow, VisualPills } from "../ui";

export function AppearanceTab() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const setBackgroundImage = useSettingsStore((s) => s.setBackgroundImage);
  const diagramStyle = useSettingsStore((s) => s.diagramStyle);
  const setDiagramStyle = useSettingsStore((s) => s.setDiagramStyle);

  const themeOptions = [
    { value: "system" as ThemeMode, label: "跟随系统" },
    { value: "light" as ThemeMode, label: "浅色" },
    { value: "dark" as ThemeMode, label: "深色" },
    { value: "warm" as ThemeMode, label: "暖色" },
    { value: "rose" as ThemeMode, label: "玫瑰" },
    { value: "spring" as ThemeMode, label: "春日星语" },
  ];

  return (
    <div className="space-y-5">
      <SettingsSection title="主题" description="选择整个应用的配色风格">
        <div className="px-4 py-3">
          <VisualPills options={themeOptions} value={theme} onChange={(v) => void setTheme(v)} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="图表风格"
        description="AI 绘制的流程图、时序图等图表的配色风格，支持全屏查看与 SVG / PNG 导出"
      >
        <div className="px-4 py-3">
          <VisualPills
            options={DIAGRAM_STYLE_OPTIONS}
            value={diagramStyle}
            onChange={(v) => void setDiagramStyle(v)}
          />
        </div>
      </SettingsSection>

      <AvatarSettingsSection />

      <BackgroundImageSection image={backgroundImage} onUpload={setBackgroundImage} />
    </div>
  );
}

function BackgroundImageSection({
  image,
  onUpload,
}: {
  image: string;
  onUpload: (data: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取文件失败"));
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      onUpload(dataUrl.split(",")[1] ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <SettingsSection
      title="背景图"
      description="建议使用横向图片；背景会自动裁剪并叠加半透明遮罩，保证文字清晰"
    >
      <div className="cf-form-row items-start">
        <div className="flex-1">
          <p className="text-ui font-medium text-ink">背景预览</p>
          <p className="mt-0.5 text-meta text-ink-2">
            {image ? "已启用自定义背景" : "使用默认纯色背景"}
          </p>
        </div>
        <div className="flex w-44 shrink-0 flex-col gap-2">
          <div className="relative h-20 overflow-hidden rounded-btn border border-line bg-panel-2">
            {image ? (
              <img src={image} alt="自定义背景图预览" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-meta text-ink-2">
                <ImageIcon size={15} /> 尚未设置背景图
              </div>
            )}
            {image && <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="rounded-btn border border-line px-2.5 py-1 text-meta text-ink transition-colors hover:bg-panel-2 disabled:opacity-40"
            >
              {uploading ? "上传中…" : image ? "更换背景图" : "上传背景图"}
            </button>
            {image && (
              <button onClick={() => void onUpload(null)} className="text-ui text-danger hover:underline">
                移除背景图
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
          </div>
          {error && <p className="text-ui text-danger">{error}</p>}
        </div>
      </div>
    </SettingsSection>
  );
}

function AvatarSettingsSection() {
  const aiAvatar = useSettingsStore((s) => s.aiAvatar);
  const aiAvatarColor = useSettingsStore((s) => s.aiAvatarColor);
  const aiAvatarImage = useSettingsStore((s) => s.aiAvatarImage);
  const setAiAvatar = useSettingsStore((s) => s.setAiAvatar);
  const setAiAvatarColor = useSettingsStore((s) => s.setAiAvatarColor);
  const setAiAvatarImage = useSettingsStore((s) => s.setAiAvatarImage);
  const userAvatarColor = useSettingsStore((s) => s.userAvatarColor);
  const userAvatarImage = useSettingsStore((s) => s.userAvatarImage);
  const setUserAvatar = useSettingsStore((s) => s.setUserAvatar);
  const setUserAvatarColor = useSettingsStore((s) => s.setUserAvatarColor);
  const setUserAvatarImage = useSettingsStore((s) => s.setUserAvatarImage);

  const aiFileRef = useRef<HTMLInputElement>(null);
  const userFileRef = useRef<HTMLInputElement>(null);
  const [uploadingAi, setUploadingAi] = useState(false);
  const [uploadingUser, setUploadingUser] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const radius = aiAvatar === "circle" ? "50%" : aiAvatar === "rounded" ? "28%" : "20%";

  const shapeOptions: { value: AvatarShape; label: string; icon: React.ReactNode }[] = [
    {
      value: "circle",
      label: "圆形",
      icon: <span className="h-3.5 w-3.5 rounded-full border border-current" />,
    },
    {
      value: "rounded",
      label: "圆角",
      icon: <span className="h-3.5 w-3.5 rounded-md border border-current" />,
    },
    {
      value: "square",
      label: "方形",
      icon: <span className="h-3.5 w-3.5 rounded-sm border border-current" />,
    },
  ];

  const handleFile = async (file: File, target: "ai" | "user") => {
    const setUploading = target === "ai" ? setUploadingAi : setUploadingUser;
    const onUpload = target === "ai" ? setAiAvatarImage : setUserAvatarImage;
    setUploading(true);
    setUploadError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result === "string") resolve(result);
          else reject(new Error("读取文件失败"));
        };
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(",")[1] ?? "";
      onUpload(base64);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const Preview = ({
    image,
    color,
    label,
  }: {
    image: string;
    color: string;
    label: string;
  }) =>
    image ? (
      <img
        src={image}
        alt={label}
        className="h-10 w-10 shrink-0 object-cover"
        style={{ borderRadius: radius }}
      />
    ) : (
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center text-meta font-bold text-white"
        style={{ backgroundColor: color, borderRadius: radius }}
      >
        {label}
      </span>
    );

  return (
    <SettingsSection title="头像设置" description="统一设置 AI 助手和你自己的头像外观">
      <div className="cf-form-row items-start">
        <div className="flex-1">
          <p className="text-ui font-medium text-ink">头像预览</p>
          <p className="mt-0.5 text-meta text-ink-2">同时应用于 AI 助手与你自己</p>
        </div>
        <div className="flex w-44 shrink-0 gap-5">
          <div className="flex flex-col items-center gap-1.5">
            <Preview image={aiAvatarImage} color={aiAvatarColor} label="AI" />
            <span className="text-meta text-ink-2">AI</span>
            <button
              onClick={() => aiFileRef.current?.click()}
              disabled={uploadingAi}
              className="rounded-btn border border-line px-2 py-0.5 text-ui text-ink transition-colors hover:bg-panel disabled:opacity-40"
            >
              {uploadingAi ? "上传中…" : aiAvatarImage ? "更换" : "上传"}
            </button>
            {aiAvatarImage && (
              <button
                onClick={() => void setAiAvatarImage(null)}
                className="text-meta text-danger hover:underline"
              >
                移除
              </button>
            )}
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Preview image={userAvatarImage} color={userAvatarColor} label="我" />
            <span className="text-meta text-ink-2">我</span>
            <button
              onClick={() => userFileRef.current?.click()}
              disabled={uploadingUser}
              className="rounded-btn border border-line px-2 py-0.5 text-ui text-ink transition-colors hover:bg-panel disabled:opacity-40"
            >
              {uploadingUser ? "上传中…" : userAvatarImage ? "更换" : "上传"}
            </button>
            {userAvatarImage && (
              <button
                onClick={() => void setUserAvatarImage(null)}
                className="text-meta text-danger hover:underline"
              >
                移除
              </button>
            )}
          </div>
        </div>
      </div>

      {uploadError && (
        <p className="px-4 pb-2 text-ui text-danger">{uploadError}</p>
      )}

      <FormRow label="头像形状" description="使用自定义图片时形状仍生效">
        <VisualPills
          options={shapeOptions}
          value={aiAvatar}
          onChange={(shape) => {
            setAiAvatar(shape);
            setUserAvatar(shape);
          }}
        />
      </FormRow>

      <div className="cf-form-row items-start">
        <div className="flex-1">
          <p className="text-ui font-medium text-ink">AI 头像颜色</p>
        </div>
        <div className="flex w-44 shrink-0 flex-wrap gap-2">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setAiAvatarColor(c)}
              className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                aiAvatarColor === c ? "border-[var(--cf-accent)]" : "border-transparent"
              }`}
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
        </div>
      </div>

      <div className="cf-form-row items-start">
        <div className="flex-1">
          <p className="text-ui font-medium text-ink">我的头像颜色</p>
        </div>
        <div className="flex w-44 shrink-0 flex-wrap gap-2">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setUserAvatarColor(c)}
              className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                userAvatarColor === c ? "border-[var(--cf-accent)]" : "border-transparent"
              }`}
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
        </div>
      </div>

      <input
        ref={aiFileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file, "ai");
          e.target.value = "";
        }}
      />
      <input
        ref={userFileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file, "user");
          e.target.value = "";
        }}
      />
    </SettingsSection>
  );
}
