import {
  ArrowLeftRight,
  ArrowRight,
  AudioLines,
  Bone,
  Boxes,
  FileJson,
  Film,
  Gauge,
  Grid2X2,
  ImagePlay,
  Images,
  Layers3,
  Music2,
  PackageCheck,
  Scissors,
  Sparkles,
  TimerReset,
} from "lucide-react";

interface ToolsWorkspaceProps {
  query: string;
  onAction: (message: string) => void;
}

const toolCategories = [
  {
    id: "spine",
    name: "Spine 动画工具",
    kicker: "SPINE ANIMATION",
    description: "检查、整理和转换 Spine 动画资源，降低版本与文件依赖问题。",
    icon: Bone,
    theme: "indigo",
    phase: "首批规划",
    keywords: "骨骼动画 atlas skel json 贴图",
    tools: [
      {
        name: "Spine 资源检查",
        description: "检查 JSON / SKEL、Atlas 与贴图是否完整，并汇总异常项",
        icon: PackageCheck,
        accent: "indigo",
      },
      {
        name: "Atlas 图集拆分",
        description: "根据 Atlas 数据还原图集中的独立附件图片",
        icon: Layers3,
        accent: "violet",
      },
      {
        name: "Spine 版本转换",
        description: "识别动画版本并生成适配目标运行时的资源副本",
        icon: FileJson,
        accent: "blue",
      },
    ],
  },
  {
    id: "frame-animation",
    name: "帧动画工具",
    kicker: "FRAME ANIMATION",
    description: "在序列帧、动图和精灵图之间转换，统一尺寸、帧率与导出规格。",
    icon: Film,
    theme: "orange",
    phase: "首批规划",
    keywords: "序列帧 gif apng webp sprite sheet 精灵图 动图",
    tools: [
      {
        name: "序列帧合成",
        description: "将一组图片按顺序合成为 GIF、APNG、WebP 或视频",
        icon: Images,
        accent: "orange",
      },
      {
        name: "动图拆帧",
        description: "从 GIF、APNG 或 WebP 中提取全部帧和时间信息",
        icon: ImagePlay,
        accent: "coral",
      },
      {
        name: "精灵图打包",
        description: "按行列或紧凑布局生成 Sprite Sheet 与配套数据",
        icon: Grid2X2,
        accent: "amber",
      },
    ],
  },
  {
    id: "audio",
    name: "音频工具",
    kicker: "AUDIO",
    description: "转换、压缩和剪辑音频文件，并逐步接入资产库素材。",
    icon: AudioLines,
    theme: "cyan",
    phase: "后续规划",
    keywords: "声音 music mp3 wav flac aac",
    tools: [
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
    ],
  },
] as const;

const totalToolCount = toolCategories.reduce((total, category) => total + category.tools.length, 0);

export function ToolsWorkspace({ query, onAction }: ToolsWorkspaceProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleCategories = toolCategories.flatMap((category) => {
    if (!normalizedQuery) return [{ ...category, tools: [...category.tools] }];

    const categoryText = `${category.name} ${category.kicker} ${category.description} ${category.keywords}`
      .toLocaleLowerCase("zh-CN");
    const categoryMatches = categoryText.includes(normalizedQuery);
    const tools = category.tools.filter((tool) => (
      categoryMatches
      || `${tool.name} ${tool.description}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    ));
    return tools.length ? [{ ...category, tools }] : [];
  });

  return (
    <main className="tools-workspace">
      <div className="tools-page-header">
        <div>
          <span className="tools-eyebrow"><Sparkles size={12} /> 创作工具箱</span>
          <h1>工具</h1>
          <p>按工作类型查找工具；这里会随着创作流程逐步增加新的分类。</p>
        </div>
        <div className="tools-summary" aria-label="工具规划统计">
          <span><strong>{toolCategories.length}</strong> 个分类</span>
          <i />
          <span><strong>{totalToolCount}</strong> 个工具</span>
        </div>
      </div>

      {!normalizedQuery && (
        <nav className="tool-category-nav" aria-label="工具分类快捷导航">
          <span>分类</span>
          {toolCategories.map(({ id, name, icon: Icon, tools }) => (
            <a href={`#tool-category-${id}`} key={id}>
              <Icon size={14} />
              {name}
              <small>{tools.length}</small>
            </a>
          ))}
        </nav>
      )}

      {visibleCategories.length > 0 ? (
        <div className="tool-category-list">
          {visibleCategories.map(({ id, name, kicker, description, icon: CategoryIcon, theme, phase, tools }) => (
            <section
              className="tool-category-card"
              data-theme={theme}
              id={`tool-category-${id}`}
              aria-labelledby={`${id}-tools-title`}
              key={id}
            >
              <div className="tool-category-intro">
                <div className="tool-category-heading">
                  <span className="tool-category-icon"><CategoryIcon size={23} /></span>
                  <span className="tool-category-phase">{phase}</span>
                </div>
                <span className="tool-category-kicker">{kicker}</span>
                <h2 id={`${id}-tools-title`}>{name}</h2>
                <p>{description}</p>
                <span className="tool-category-count"><Boxes size={13} /> {tools.length} 个工具</span>
              </div>

              <div className="tool-item-list">
                {tools.map(({ name: toolName, description: toolDescription, icon: Icon, accent }) => (
                  <button
                    className="tool-item"
                    key={toolName}
                    onClick={() => onAction(`${toolName}已加入规划，功能将逐步开放`)}
                  >
                    <span className={`tool-item-icon ${accent}`}><Icon size={19} /></span>
                    <span className="tool-item-copy">
                      <strong>{toolName}</strong>
                      <small>{toolDescription}</small>
                    </span>
                    <span className="tool-status"><TimerReset size={11} /> 规划中</span>
                    <ArrowRight className="tool-item-arrow" size={17} />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="tools-empty-state">
          <Sparkles size={28} />
          <strong>没有找到相关工具</strong>
          <span>试试搜索“Spine”“序列帧”“Atlas”或“音频”</span>
        </div>
      )}

      <section className="more-tools-placeholder" aria-label="更多工具规划">
        <div>
          <span className="placeholder-icon"><Sparkles size={18} /></span>
          <div>
            <strong>工具分类会持续扩展</strong>
            <span>后续可继续增加图片、视频、格式转换与批处理等分类</span>
          </div>
        </div>
        <span>逐步开放</span>
      </section>
    </main>
  );
}
