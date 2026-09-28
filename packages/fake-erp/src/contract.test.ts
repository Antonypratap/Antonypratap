import { describeErpConnectorContract } from '@veyra/erp-connector/contract';
import { tempErp } from './test/temp-db';

// Phase 2 exit criterion: the unmodified Phase 1 contract suite passes against FakeErpConnector.
describeErpConnectorContract({
  name: 'FakeErpConnector',
  setup: async () => {
    const t = tempErp({ reset: 'company-only' });
    return {
      connector: t.erp,
      reopen: async () => t.open(),
      teardown: async () => t.cleanup(),
    };
  },
});
