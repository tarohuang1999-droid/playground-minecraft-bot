import { action, createTree, parallel, reactiveSelector } from './nodes.ts';
import { survivalSubtree } from './subtrees/survival.ts';
import { combatSubtree } from './subtrees/combat.ts';
import { workSubtree } from './subtrees/work.ts';
import { maintenanceSubtree } from './subtrees/maintenance.ts';

export function createCompanionTree(available: ReadonlySet<string>) {
  return createTree(parallel('companion', [
    reactiveSelector('primary', [survivalSubtree(available), combatSubtree(available), workSubtree(available),
      action('idle', () => ({ actionType: 'Idle', targetId: null, params: {} })),
    ]),
    maintenanceSubtree(available),
  ], { persistent: true }));
}
