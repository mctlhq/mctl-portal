import { ReactNode } from 'react';
import { Typography } from '@material-ui/core';
import { Observed } from './types';

/**
 * Renders an Observed<T> so that unknown never reads as empty or success:
 * "None" is shown only for an ok, empty list.
 */
export function ObservedSection<T>(props: {
  title: string;
  data: Observed<T>;
  render: (value: T) => ReactNode;
}) {
  const { title, data, render } = props;
  let body: ReactNode;
  if (data.state === 'unknown') {
    body = (
      <Typography variant="body2" color="textSecondary">
        {data.reason === 'not_available_via_relay' ? 'Not available yet' : 'Unknown'}
      </Typography>
    );
  } else {
    const isEmpty = Array.isArray(data.value) ? data.value.length === 0 : data.value === null || data.value === undefined;
    body = (
      <>
        {data.state === 'stale' && (
          <Typography variant="caption" color="textSecondary" component="div">
            Stale since {data.observedAt}
          </Typography>
        )}
        {isEmpty ? <Typography variant="body2">None</Typography> : render(data.value)}
      </>
    );
  }
  return (
    <div data-testid={`section-${title}`}>
      <Typography variant="subtitle1">{title}</Typography>
      {body}
    </div>
  );
}
