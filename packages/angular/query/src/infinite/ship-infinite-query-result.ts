import type {
  CreateInfiniteQueryResult,
  FetchNextPageOptions,
  FetchPreviousPageOptions,
  InfiniteQueryObserverResult,
  RefetchOptions,
} from '@tanstack/angular-query-experimental';

/** Native signals with page methods that always share an existing request. */
export type ShipInfiniteQueryResult<TSelected> = Omit<
  CreateInfiniteQueryResult<TSelected, Error>,
  'refetch' | 'fetchNextPage' | 'fetchPreviousPage'
> & {
  refetch(
    options?: Omit<RefetchOptions, 'cancelRefetch'>
  ): Promise<InfiniteQueryObserverResult<TSelected, Error>>;
  fetchNextPage(
    options?: Omit<FetchNextPageOptions, 'cancelRefetch'>
  ): Promise<InfiniteQueryObserverResult<TSelected, Error>>;
  fetchPreviousPage(
    options?: Omit<FetchPreviousPageOptions, 'cancelRefetch'>
  ): Promise<InfiniteQueryObserverResult<TSelected, Error>>;
};
