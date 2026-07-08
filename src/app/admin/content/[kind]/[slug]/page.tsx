import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getContentEditorState } from '@/lib/admin/content';
import { isCmsKind } from '@/lib/cms/schemas';
import { ContentEditor } from './ContentEditor';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ kind: string; slug: string }> };

export default async function ContentEditorPage({ params }: Props) {
  const { kind, slug } = await params;
  if (!isCmsKind(kind)) notFound();
  const state = await getContentEditorState(kind, slug);
  if (!state) notFound();

  return (
    <>
      <Link className="adm-back" href="/admin/content">← Tresci</Link>
      <div className="adm-fulfillment-head">
        <div>
          <h1 className="adm-h1">{state.label}</h1>
          <p className="adm-sub">
            <span className="adm-mono">{state.kind}:{state.slug}</span> · {state.items.length} opisow
          </p>
        </div>
        <div className="adm-actions adm-actions--top">
          <Link className="adm-btn" href={`/admin/content/${state.kind}/${state.slug}/history`}>Historia</Link>
          <Link className="adm-btn" href={state.publicPath} target="_blank">Strona publiczna</Link>
        </div>
      </div>

      <ContentEditor state={state} />
    </>
  );
}
