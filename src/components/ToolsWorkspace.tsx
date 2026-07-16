import {
  ArrowLeftRight,
  ArrowRight,
  AudioLines,
  Gauge,
  Music2,
  Scissors,
  Sparkles,
} from "lucide-react";

interface ToolsWorkspaceProps {
  query: string;
  onAction: (message: string) => void;
}

const audioTools = [
  {
    name: "音频格式转换",
    description: "在 MP3、WAV、FLAC、AAC 等常用格式间转换",
    icon: ArrowLeftRight,
    accent: "blue",
  },
  {
    name: "音频压缩",
    description: "减小音频文件体积，并平衡音质与输出大小",
    icon: Gauge,
    accent: "violet",
  },
  {
    name: "音频剪辑",
    description: "截取需要的片段，快速调整音频起止位置",
    icon: Scissors,
    accent: "coral",
  },
] as const;

export function ToolsWorkspace({ query, onAction }: ToolsWorkspaceProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleTools = audioTools.filter((tool) => {
    if (!normalizedQuery) return true;
    return `${tool.name} ${tool.description} 音频`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
  });

  return (
    <main className="tools-workspace">
      <div className="tools-page-header">
        <div>
          <span className="tools-eyebrow"><Sparkles size={12} /> 创作工具箱</span>
          <h1>工具</h1>
          <p>集中处理常见的媒体任务，让素材处理更简单。</p>
        </div>
        <div className="tools-summary" aria-label="工具统计">
          <strong>{audioTools.length}</strong>
          <span>个工具即将开放</span>
        </div>
      </div>

      {visibleTools.length > 0 ? (
        <section className="tool-category-card" aria-labelledby="audio-tools-title">
          <div className="tool-category-intro">
            <span className="tool-category-icon"><AudioLines size={24} /></span>
            <div>
              <span className="tool-category-kicker">AUDIO</span>
              <h2 id="audio-tools-title">音频工具</h2>
              <p>转换、压缩和剪辑音频文件，后续可直接从资产库选择素材。</p>
            </div>
            <span className="tool-category-count"><Music2 size={13} /> {visibleTools.length} 个工具</span>
          </div>

          <div className="audio-tool-list">
            {visibleTools.map(({ name, description, icon: Icon, accent }) => (
              <button
                className="audio-tool-item"
                key={name}
                onClick={() => onAction(`${name}即将开放`)}
              >
                <span className={`audio-tool-icon ${accent}`}><Icon size={20} /></span>
                <span className="audio-tool-copy">
                  <strong>{name}</strong>
                  <small>{description}</small>
                </span>
                <span className="coming-soon">即将开放</span>
                <ArrowRight className="audio-tool-arrow" size={17} />
              </button>
            ))}
          </div>
        </section>
      ) : (
        <div className="tools-empty-state">
          <AudioLines size={28} />
          <strong>没有找到相关工具</strong>
          <span>尝试搜索“音频”“转换”或“剪辑”</span>
        </div>
      )}

      <section className="more-tools-placeholder" aria-label="更多工具">
        <div>
          <span className="placeholder-icon"><Sparkles size={18} /></span>
          <div>
            <strong>更多工具正在整理</strong>
            <span>图片与视频工具将陆续加入这里</span>
          </div>
        </div>
        <span>敬请期待</span>
      </section>
    </main>
  );
}
