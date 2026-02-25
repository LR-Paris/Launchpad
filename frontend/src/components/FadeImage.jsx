import { useState, useCallback, useRef } from 'react';

/**
 * Image component that shows a shimmer placeholder color block and
 * crossfades to the real image once it finishes loading.
 *
 * Usage — drop-in replacement for <img>. All sizing / rounding /
 * border classes go on the outer className as usual.
 */
export default function FadeImage({ src, alt, className = '', style, ...rest }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const prevSrc = useRef(src);

  // Reset state when src changes (e.g. image replaced)
  if (src !== prevSrc.current) {
    prevSrc.current = src;
    setLoaded(false);
    setError(false);
  }

  const handleLoad = useCallback(() => setLoaded(true), []);
  const handleError = useCallback(() => { setLoaded(true); setError(true); }, []);

  return (
    <div className={`fade-img-wrap ${className}`} style={style}>
      {/* Shimmer placeholder — visible until image loads */}
      <div
        className={`fade-img-placeholder ${loaded ? 'fade-img-placeholder--hidden' : ''}`}
        aria-hidden
      />
      {!error ? (
        <img
          src={src}
          alt={alt || ''}
          onLoad={handleLoad}
          onError={handleError}
          className={`fade-img ${loaded ? 'fade-img--visible' : ''}`}
          draggable={false}
          {...rest}
        />
      ) : (
        <div className="fade-img-error">
          <span>Failed to load</span>
        </div>
      )}
    </div>
  );
}
