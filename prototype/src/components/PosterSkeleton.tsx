/**
 * 海报骨架屏：首屏只有转圈时用户看不到"要出现什么"。
 * 用同尺寸的占位卡把版面先撑起来，加载完成后视觉不跳。
 */
export default function PosterSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="poster-grid poster-grid--page skeleton-grid" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-card" key={index} />
      ))}
    </div>
  )
}
