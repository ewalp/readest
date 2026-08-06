'use client';

import React, { useMemo } from 'react';
import { cn } from '@/utils/tailwind';

interface RoseCurveLoaderProps {
  className?: string;
  size?: number;
  k?: number; // Rose curve parameter (petals)
  particleCount?: number;
}

export const RoseCurveLoader: React.FC<RoseCurveLoaderProps> = ({
  className,
  size = 40,
  k = 5,
  particleCount = 12,
}) => {
  const pathD = useMemo(() => {
    const points: string[] = [];
    const R = size / 2 - 4; // Margin of 4px
    const center = size / 2;
    const steps = 180; // Smooth curve

    // For odd k, theta from 0 to PI. For even k, 0 to 2*PI
    const limit = k % 2 === 0 ? Math.PI * 2 : Math.PI;

    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * limit;
      const r = R * Math.cos(k * theta);
      const x = center + r * Math.cos(theta);
      const y = center + r * Math.sin(theta);
      points.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return points.join(' ') + ' Z';
  }, [size, k]);

  // Generate particles with staggered delays to form a tail
  const particles = useMemo(() => {
    return Array.from({ length: particleCount }).map((_, idx) => {
      // Calculate opacity and size to make it look like a fading tail
      const progress = idx / (particleCount - 1); // 0 to 1
      const opacity = 0.15 + (1 - progress) * 0.85; // newer particles are brighter
      const r = 1 + (1 - progress) * 2; // newer particles are larger
      // Staggered delay: negative delay starts the animation at different points along the path
      const delay = -(idx * 0.15).toFixed(2) + 's';

      return {
        id: idx,
        r,
        opacity,
        delay,
      };
    });
  }, [particleCount]);

  return (
    <div className={cn('inline-flex items-center justify-center p-1', className)}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className='text-primary overflow-visible'
      >
        {/* Glow filter for premium feel */}
        <defs>
          <filter id='rose-glow' x='-20%' y='-20%' width='140%' height='140%'>
            <feGaussianBlur stdDeviation='1.5' result='blur' />
            <feComposite in='SourceGraphic' in2='blur' operator='over' />
          </filter>
        </defs>

        {/* Muted background path to see the geometry */}
        <path
          d={pathD}
          fill='none'
          stroke='currentColor'
          strokeWidth='1.5'
          className='text-base-content/5 opacity-10'
        />

        {/* Glow/blurred path for a soft neon effect */}
        <path
          d={pathD}
          fill='none'
          stroke='currentColor'
          strokeWidth='2.5'
          className='text-primary opacity-30'
          filter='url(#rose-glow)'
        />

        {/* Particles flying along the path */}
        {particles.map((p) => (
          <circle
            key={p.id}
            r={p.r}
            fill='currentColor'
            className='text-primary'
            style={{
              opacity: p.opacity,
              filter: 'drop-shadow(0 0 2px currentColor)',
            }}
          >
            <animateMotion
              dur='2.5s'
              repeatCount='indefinite'
              path={pathD}
              begin={p.delay}
              calcMode='linear'
            />
          </circle>
        ))}
      </svg>
    </div>
  );
};
