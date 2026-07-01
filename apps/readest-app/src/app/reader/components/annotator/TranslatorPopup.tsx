import React, { useEffect, useState } from 'react';
import Popup from '@/components/Popup';
import { Position } from '@/utils/sel';
import { useTranslation } from '@/hooks/useTranslation';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';

interface ZuciItem {
  name?: string;
  isClick?: boolean;
}

interface BasicDefinitionItem {
  definition?: string;
  cixing?: string[];
  zuci?: ZuciItem[];
}

interface ComprehensiveDefinitionItem {
  pinyin?: string;
  basicDefinition?: BasicDefinitionItem[];
}

interface PinyinItem {
  name: string;
  voice?: string;
}

interface WordDetail {
  traditional?: string;
  radical?: string;
  wordStrokeCount?: string;
  pinyinList?: PinyinItem[];
  comprehensiveDefinition?: ComprehensiveDefinitionItem[];
}

interface TranslatorPopupProps {
  text: string;
  position: Position;
  trianglePosition: Position;
  popupWidth: number;
  popupHeight: number;
  onDismiss?: () => void;
}

const TranslatorPopup: React.FC<TranslatorPopupProps> = ({
  text,
  position,
  trianglePosition,
  popupWidth,
  popupHeight,
  onDismiss,
}) => {
  const _ = useTranslation();
  const [translation, setTranslation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const fetchTranslation = async () => {
      setError(null);
      setTranslation(null);

      try {
        const input = text.replaceAll('\n', '').trim();
        if (!input) {
          setTranslation('');
          return;
        }

        // 1. 获取 acs-token
        const postUrl = 'https://banti.baidu.com/dr?&_o=https%3A%2F%2Fhanyu.baidu.com';
        const fetchFn = isTauriAppPlatform() ? tauriFetch : window.fetch;
        
        const dValue = '857WGM12bpINVUphbCV8qcEQSf61gzPLNpeCXqbhMTCRZmBTo9q7rn1PMrCRCsavN59nS0GXdsRsyhx4ZbnLux5wfrvdEemiLsVKlM87fteS4njGg38D01IklMR+Cd6K9pCHiKvpsJDtiNTOTb6Ty/ZT9WUyTIR+p479z8yJLoqff0IEFt+EmEma3ycZc4RGxnGaBjVh6hAlyArfIX/VKeL8JdH0zI9h9PKvlwZ8tS96hCwCTHHDB+Vavlew2iUPlhNBhRB4/ATuhv9qU1j3y8JKSXzEyPSDq510aTdQgHqp8RejNxRzDEEsg4SkrP23auocOae9eb7pu2HbYVOPdTb/0NSlgoyLMxpWg2icjCMFzFYquZNLjqEnQQnp913bam/RK9g7Sxi6QIMvYGZVAMk3fY/38pUjko79PIGDHu2Qvgj/ZSi+wWaGbVHkHX0qlmJM16MpRrSjzQ3cO/EclVN6VTDYEiObVZM4usLocnFGTsn0WLSc4DRL4heCQwMJEiAZ40p+lUSxpZZfbWLy74WM9z2zvJQe3iUc0PPk+F6qMx54ns++wfF6MvKRWKoKmv4WVnpKCob+8OK62/O2QQVvjmIbc0dBi+k/Nce0XzVjaOIUeXm6Y5Rp5LNFu/v//F+2+pDJGaVHMi16ETQGSWvzYsEQHhCT0nzNrr4SZxDpCzUHhtWmnVFFxv2OhAbSkwXp0bHz26izjuNyzX3H728fQSprk8J9LU6LjQVCSj1UHzzX5xfBFw2umkzVLx8D+VDXy1w1kTqDNWqElEuQwSMuBoz/54eQZsXiqVnYZFz826aqJit2QX0LBQfBkmT8777gO+oKVbLKMZc4TzVcxXeYcLy4bVsBfRsxAejLZtNcy8QYQ5GoSC+BnLvlfRtd8ACSKzOneuY8L6gUXhT9kbosT2xQ0wrdNtqL7iXZGObHIftzta5hYDn2soHXGNpZWynoBX8SpWI8Yv6GY7SlHTq9qEgpk6NJTg4pVKWAZgjLUjKltdnY0t8tkrCrTsVte/80q7RveMBlFb19hhgq8nOBZeKN3R+KPY5kSgp5AAzumaae80g21GRs0DwJxnAAW/iY+2bXlHe1BJkZMGXypl+LDt0KbRw0O7rvIoNW4mSZTR9yxeUAIImbsgcFq8FW62imJUbnxL+zp9ggF90g1X3+LeGQuhiUg24/tXiCjbBmP3nyIxaalTuiwyr+LwFGji8azcW7TReBCrudR1z9RgX4V9bbO8YLKP1zJ9oCpwvzokm6McQDE9tYRDAOJ+FEno54+qAJiGMXyeNG4BTbS33IuoZ4Cd03XqWC4GoT4WkRGpEbhOlAbG1XM8rW2/e9jGJOVJ8wf2Jypiqm0pDvKtpU3GcVlkkv8hYHd11BIv1G+f2qyL4zmAObl8aaRN8eIWuCP0VzS0FP0xk62Zp3IdJWWYKH0BzAQgngLxYQM0R3oq1dKeDlESGeg/U/gDNC816infm2cqg1RxzmjE4hg082DC1fYYezTu7uO5XTI3ceagXmjyexIX5r4WJI+5UWEO6jwEx+kq2g8zYblB19WnE454R+zcb0qxyWlKXbkahPfeih3gmOqXJfIUxvnhXhg6Rblk85Asthz+3KcAE1GO9g5hQXY+jM0Ma/SnWpWw==';
        const postBody = JSON.stringify({ d: dValue });

        const postResponse = await fetchFn(postUrl, {
          method: 'POST',
          headers: {
            'content-type': 'text/plain;charset=UTF-8',
            'origin': 'https://hanyu.baidu.com',
            'referer': 'https://hanyu.baidu.com/',
          },
          body: postBody,
        });

        if (!postResponse.ok) {
          throw new Error(`Failed to fetch acs-token: ${postResponse.status}`);
        }

        const postData = await postResponse.json() as {
          ymg?: {
            data?: string;
          };
        };
        const acsToken = postData?.ymg?.data;
        if (!acsToken) {
          throw new Error('acs-token not found in response');
        }

        // 2. 拆分成单个字分别获取拼音及释义
        const chars = Array.from(input).filter((c) => /[\u4e00-\u9fa5]/.test(c));
        if (chars.length === 0) {
          setTranslation('未检测到中文字符。');
          return;
        }

        const results = await Promise.all(
          chars.map(async (char) => {
            try {
              const detailUrl = `https://hanyuapp.baidu.com/dictapp/word/detail_getworddetail?wd=${encodeURIComponent(char)}&client=pc&lesson_from=xiaodu&smp_names=wordNewData1`;
              const detailRes = await fetchFn(detailUrl, {
                method: 'GET',
                headers: {
                  'acs-token': acsToken,
                  'user-agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
                },
              });

              if (!detailRes.ok) {
                return `${char}: 获取失败`;
              }

              const detailData = await detailRes.json() as {
                data?: {
                  detail?: WordDetail;
                };
              };
              const detail = detailData?.data?.detail;
              if (!detail) {
                return `${char}: 未找到释义数据`;
              }

              const traditional = detail.traditional ? ` (繁:${detail.traditional})` : '';
              const radical = detail.radical ? ` 部首:${detail.radical}` : '';
              const strokes = detail.wordStrokeCount ? ` 笔画:${detail.wordStrokeCount}` : '';
              const headerLine = `【${char}】${traditional}${radical}${strokes}`;

              const definitions: string[] = [];
              const compDef = detail.comprehensiveDefinition;
              if (compDef && Array.isArray(compDef)) {
                compDef.forEach((cd: ComprehensiveDefinitionItem) => {
                  const py = cd.pinyin;
                  const basicDefs = cd.basicDefinition;
                  if (basicDefs && Array.isArray(basicDefs)) {
                    basicDefs.forEach((bd: BasicDefinitionItem) => {
                      const defText = bd.definition || '';
                      const zuciText = bd.zuci && Array.isArray(bd.zuci)
                        ? bd.zuci.filter((z: ZuciItem) => z.name).slice(0, 3).map((z: ZuciItem) => z.name).join('、')
                        : '';
                      definitions.push(`  • [${py}] ${defText}${zuciText ? ` (组词: ${zuciText})` : ''}`);
                    });
                  }
                });
              }

              if (definitions.length === 0 && detail.pinyinList && Array.isArray(detail.pinyinList)) {
                const pinyins = detail.pinyinList.map((p: PinyinItem) => p.name).join(', ');
                definitions.push(`  • 拼音: ${pinyins}`);
              }

              return `${headerLine}\n${definitions.join('\n')}`;
            } catch (e) {
              return `${char}: 查询出错`;
            }
          }),
        );

        setTranslation(results.join('\n\n'));
      } catch (err) {
        console.error(err);
        setError('获取拼音失败，请稍后重试。');
      } finally {
        setLoading(false);
      }
    };

    fetchTranslation();
  }, [text]);

  return (
    <div>
      <Popup
        trianglePosition={trianglePosition}
        width={popupWidth}
        minHeight={popupHeight}
        maxHeight={720}
        position={position}
        className='not-eink:text-white grid h-full select-text grid-rows-[1fr,auto,1fr] bg-gray-600'
        triangleClassName='text-gray-600'
        onDismiss={onDismiss}
      >
        <div className='overflow-y-auto p-4 font-sans'>
          <div className='mb-2 flex items-center justify-between'>
            <h1 className='text-sm font-normal'>{_('Original Text')}</h1>
          </div>
          <p className='not-eink:text-white/90 text-base'>{text}</p>
        </div>

        <div className='mx-4 flex-shrink-0 border-t border-gray-500/30'></div>

        <div className='overflow-y-auto px-4 pb-8 pt-4 font-sans'>
          <div className='mb-2 flex items-center justify-between'>
            <h2 className='text-sm font-normal'>拼音</h2>
          </div>
          {loading ? (
            <p className='text-base italic text-gray-500'>{_('Loading...')}</p>
          ) : (
            <div>
              {error ? (
                <p className='text-base text-red-600'>{error}</p>
              ) : (
                <p className='not-eink:text-white/90 whitespace-pre-wrap text-base'>
                  {translation || '无拼音数据。'}
                </p>
              )}
            </div>
          )}
        </div>
        <div className='absolute bottom-0 flex h-8 w-full items-center justify-between px-4'>
          <div className='line-clamp-1 text-xs opacity-60'>Powered by Baidu Hanyu</div>
        </div>
      </Popup>
    </div>
  );
};

export default TranslatorPopup;
