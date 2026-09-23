import Link from "next/link";
import type { FeedParams } from "@/lib/queries/feed";
import { SOURCE_LABELS, SOURCE_TYPES } from "@/lib/types";

const input =
  "rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700";

/**
 * Plain GET form: submitting writes the filters into the URL search params, so
 * it works without client JavaScript and every view is linkable.
 */
export function FilterForm({
  action,
  values,
  withSort = false,
  withHidden = false,
}: {
  action: string;
  values: Omit<FeedParams, "limit" | "sort" | "showHidden"> & Partial<Pick<FeedParams, "sort" | "showHidden">>;
  withSort?: boolean;
  withHidden?: boolean;
}) {
  const allSources = values.sources.length === 0;
  return (
    <form action={action} method="get" role="search" className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-neutral-600">
          Search
          <input type="search" name="q" defaultValue={values.q} placeholder="Title, excerpt or source" className={input} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
          From
          <input type="date" name="from" defaultValue={values.from ?? ""} className={input} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
          To
          <input type="date" name="to" defaultValue={values.to ?? ""} className={input} />
        </label>
        {withSort && (
          <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
            Sort by
            <select name="sort" defaultValue={values.sort ?? "chronological"} className={input}>
              <option value="chronological">Chronological</option>
              <option value="relevant">Relevant (reach)</option>
            </select>
          </label>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <legend className="sr-only">Sources</legend>
          <span aria-hidden="true" className="text-xs font-medium text-neutral-600">
            Sources
          </span>
          {SOURCE_TYPES.map((s) => (
            <label key={s} className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                name="source"
                value={s}
                defaultChecked={allSources || values.sources.includes(s)}
                className="h-4 w-4 accent-sky-700"
              />
              {SOURCE_LABELS[s]}
            </label>
          ))}
        </fieldset>
        {withHidden && (
          <label className="inline-flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name="hidden"
              value="1"
              defaultChecked={values.showHidden}
              className="h-4 w-4 accent-sky-700"
            />
            Show hidden
          </label>
        )}
        <div className="ml-auto flex items-center gap-3">
          <Link href={action} className="text-sm text-neutral-600 hover:text-neutral-900">
            Reset
          </Link>
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
          >
            Apply
          </button>
        </div>
      </div>
    </form>
  );
}
