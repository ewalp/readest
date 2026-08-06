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

        const fetchFn = isTauriAppPlatform() ? tauriFetch : window.fetch;

        // 拆分成单个字分别获取拼音及释义
        const chars = Array.from(input).filter((c) => /[\u4e00-\u9fa5]/.test(c));
        if (chars.length === 0) {
          setTranslation('未检测到中文字释义。');
          return;
        }

        const results = await Promise.all(
          chars.map(async (char) => {
            try {
              const detailUrl = `https://hanyuapp.baidu.com/dictapp/word/detail_getworddetail?wd=${encodeURIComponent(char)}&client=pc&lesson_from=xiaodu&smp_names=wordNewData1`;
              const detailRes = await fetchFn(detailUrl, {
                method: 'GET',
                headers: {
                  'Acs-Token': '163',
                  Referer: 'https://hanyu.baidu.com/',
                  'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
                  Accept: 'application/json, text/plain, */*',
                },
              });

              if (!detailRes.ok) {
                return `${char}: 获取失败`;
              }

              const detailData = (await detailRes.json()) as {
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
                  const py = cd.pinyin || '无';
                  definitions.push(`  📖 读音: ${py}`);
                  const basicDefs = cd.basicDefinition;
                  if (basicDefs && Array.isArray(basicDefs)) {
                    basicDefs.forEach((bd: BasicDefinitionItem, index: number) => {
                      const defText = bd.definition || '';
                      if (defText) {
                        definitions.push(`     • 📝 释义${index + 1}: ${defText}`);
                      }
                      const zuciText =
                        bd.zuci && Array.isArray(bd.zuci)
                          ? bd.zuci
                              .filter((z: ZuciItem) => z.name)
                              .slice(0, 3)
                              .map((z: ZuciItem) => z.name)
                              .join('、')
                          : '';
                      if (zuciText) {
                        definitions.push(`       🔤 组词: ${zuciText}`);
                      }
                    });
                  }
                });
              }

              if (
                definitions.length === 0 &&
                detail.pinyinList &&
                Array.isArray(detail.pinyinList)
              ) {
                const pinyins = detail.pinyinList.map((p: PinyinItem) => p.name).join(', ');
                definitions.push(`  • 拼音: ${pinyins}`);
              }

              return `${headerLine}\n${definitions.join('\n')}`;
            } catch (_e) {
              return `${char}: 查询出错`;
            }
          }),
        );

        setTranslation(results.join('\n\n'));
      } catch (err) {
        console.error(err);
        setError('获取拼音/字典失败，请稍后重试。');
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
        className='not-eink:text-white grid h-full select-text grid-rows-[auto,auto,1fr,auto] bg-gray-600'
        onDismiss={onDismiss}
      >
        <div className='max-h-[160px] overflow-y-auto p-4 font-sans'>
          <div className='mb-2 flex items-center justify-between'>
            <h1 className='text-sm font-normal'>{_('Original Text')}</h1>
          </div>
          <p className='text-base'>{text}</p>
        </div>

        <div className='mx-4 flex-shrink-0 border-t border-base-content/20'></div>

        <div className='overflow-y-auto p-4 font-sans'>
          <div className='mb-2 flex items-center justify-between'>
            <h2 className='text-sm font-normal'>字典释义 / 拼音</h2>
          </div>
          {loading ? (
            <p className='text-base-content/80 italic'>{_('Loading...')}</p>
          ) : (
            <div>
              {error ? (
                <p className='text-base text-red-600'>{error}</p>
              ) : (
                <p className='not-eink:text-white/90 whitespace-pre-wrap text-base'>
                  {translation || '无拼音/字典数据。'}
                </p>
              )}
            </div>
          )}
        </div>
        <div className='flex shrink-0 items-center justify-between gap-2 rounded-b-lg px-4 py-2 text-xs opacity-60'>
          <div>Powered by Baidu Hanyu</div>
        </div>
      </Popup>
    </div>
  );
};

export default TranslatorPopup;
