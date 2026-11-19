import { useCallback, useEffect, useRef, useState } from "react";
import type {
  UsageBreakdown,
  UsageOverview,
  UsageRange,
  UsageRecordPage,
  UsageStatsAPI,
} from "../../../shared/usage-stats-api";
import { presetRange } from "./format";
export type UsageActivityClient = Pick<
  UsageStatsAPI,
  "usageOverview" | "usageBreakdown" | "usageRecords"
>;
export function useUsageActivity(
  client: UsageActivityClient,
  onError: (error: unknown) => void,
) {
  const [overview, setOverview] = useState<UsageOverview | null>();
  const [range, setRange] = useState<UsageRange>(() => presetRange("7"));
  const [breakdown, setBreakdown] = useState<UsageBreakdown>();
  const [loadingRange, setLoadingRange] = useState(false);
  const [breakdownFailed, setBreakdownFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [model, setModel] = useState("");
  const [records, setRecords] = useState<UsageRecordPage>();
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [recordsFailed, setRecordsFailed] = useState(false);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const staleOverview = useRef(0);
  const [revision, setRevision] = useState(0);
  const staleRange = useRef(0);
  const staleRecords = useRef(0);

  const loadOverview = useCallback(() => {
    const mine = ++staleOverview.current;
    setLoadingOverview(true);
    return Promise.resolve()
      .then(() => client.usageOverview())
      .then(
        (value) => {
          if (mine === staleOverview.current) setOverview(value);
        },
        (error: unknown) => {
          if (mine !== staleOverview.current) return;
          setOverview(null);
          onError(error);
        },
      )
      .finally(() => {
        if (mine === staleOverview.current) setLoadingOverview(false);
      });
  }, [onError, client]);
  useEffect(() => {
    void loadOverview();
    return () => {
      staleOverview.current++;
    };
  }, [loadOverview]);

  useEffect(() => {
    if (!overview) return;
    const mine = ++staleRange.current;
    setLoadingRange(true);
    setBreakdownFailed(false);
    setBreakdown(undefined);
    Promise.resolve()
      .then(() => client.usageBreakdown(range))
      .then(
        (value) => mine === staleRange.current && setBreakdown(value),
        (error: unknown) => {
          if (mine === staleRange.current) {
            setBreakdownFailed(true);
            onError(error);
          }
        },
      )
      .finally(() => mine === staleRange.current && setLoadingRange(false));
    return () => {
      staleRange.current++;
    };
  }, [
    client,
    revision,
    overview === null || overview === undefined,
    range.start,
    range.end,
    range.granularity,
  ]);

  useEffect(() => {
    if (!overview) return;
    const mine = ++staleRecords.current;
    setLoadingRecords(true);
    setRecordsFailed(false);
    setRecords(undefined);
    Promise.resolve()
      .then(() =>
        client.usageRecords({
          page,
          pageSize: 10,
          start: range.start,
          end: range.end,
          ...(model ? { model } : {}),
        }),
      )
      .then(
        (value) => mine === staleRecords.current && setRecords(value),
        (error: unknown) => {
          if (mine === staleRecords.current) {
            setRecordsFailed(true);
            onError(error);
          }
        },
      )
      .finally(() => mine === staleRecords.current && setLoadingRecords(false));
    return () => {
      staleRecords.current++;
    };
  }, [
    client,
    revision,
    overview === null || overview === undefined,
    page,
    model,
    range.start,
    range.end,
  ]);

  const chooseRange = (next: UsageRange) => {
    setPage(1);
    setRange(next);
  };
  const chooseModel = (next: string) => {
    setPage(1);
    setModel(next);
  };
  const refresh = () => {
    void loadOverview();
    setRevision((value) => value + 1);
    setPage(1);
    setRange((value) => ({ ...value }));
  };
  return {
    overview,
    range,
    breakdown,
    loadingRange,
    breakdownFailed,
    page,
    model,
    records,
    loadingRecords,
    recordsFailed,
    loadingOverview,
    chooseRange,
    chooseModel,
    setPage,
    refresh,
    loadOverview,
    setRevision,
    setRange,
    setModel,
  };
}
