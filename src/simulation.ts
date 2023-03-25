import { PublicKey, RpcResponseAndContext, VersionedTransaction } from '@solana/web3.js';
import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import { logger } from './logger.js';
import { connection } from './connection.js';
import { SimulatedBundleResponse } from 'jito-ts';
import { FilteredTransaction } from './preSimulationFilter.js';
import { Timings } from './types.js';

type SimulationResult = {
  txn: VersionedTransaction;
  response: RpcResponseAndContext<SimulatedBundleResponse>;
  accountsOfInterest: PublicKey[];
  timings: Timings;
};

const pendingSimulations = new Map<
  string,
  Promise<{
    uuid: string;
    txn: VersionedTransaction;
    response: RpcResponseAndContext<SimulatedBundleResponse> | null;
    accountsOfInterest: PublicKey[];
    timings: Timings;
  }>
>();

async function startSimulations(
  txnIterator: AsyncGenerator<FilteredTransaction>,
  eventEmitter: EventEmitter,
) {
  for await (const { txn, accountsOfInterest, timings } of txnIterator) {
    const addresses = accountsOfInterest.map((key) => key.toBase58());
    const sim = connection.simulateBundle([txn], {
      preExecutionAccountsConfigs: [{ addresses, encoding: 'base64' }],
      postExecutionAccountsConfigs: [{ addresses, encoding: 'base64' }],
      simulationBank: 'tip',
    });
    const uuid = randomUUID(); // use hash instead of uuid?
    pendingSimulations.set(
      uuid,
      sim
        .then((res) => {
          return {
            uuid: uuid,
            txn,
            response: res,
            accountsOfInterest,
            timings,
          };
        })
        .catch((e) => {
          logger.error(e);
          return {
            uuid: uuid,
            txn,
            response: null,
            accountsOfInterest,
            timings,
          };
        }),
    );
    eventEmitter.emit('addPendingSimulation', uuid);
  }
}

async function* simulate(
  txnIterator: AsyncGenerator<FilteredTransaction>,
): AsyncGenerator<SimulationResult> {
  const eventEmitter = new EventEmitter();
  startSimulations(txnIterator, eventEmitter);

  while (true) {
    if (pendingSimulations.size === 0) {
      await new Promise((resolve) =>
        eventEmitter.once('addPendingSimulation', resolve),
      );
    }

    const { uuid, txn, response, accountsOfInterest, timings } =
      await Promise.race(pendingSimulations.values());
    logger.debug(`Simulation ${uuid} took ${Date.now() - timings.preSimEnd}ms`);
    if (response !== null) {
      yield {txn, response, accountsOfInterest, timings: {
        mempoolEnd: timings.mempoolEnd,
        preSimEnd: timings.preSimEnd,
        simEnd: Date.now(),
        postSimEnd: 0,
        calcArbEnd: 0,
      },};
    }
    pendingSimulations.delete(uuid);
  }
}

export { simulate, SimulationResult };
