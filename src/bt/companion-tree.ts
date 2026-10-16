import { action, createTree, parallel, reactiveSelector } from './nodes.ts';
import { survivalSubtree } from './subtrees/survival.ts';
import { combatSubtree } from './subtrees/combat.ts';
import { workSubtree } from './subtrees/work.ts';
import { maintenanceSubtree } from './subtrees/maintenance.ts';

import type { NavigationLogger } from '../actions/navigation.ts';

export function createCompanionTree(
  available: ReadonlySet<string>,
  options?: {
    onNavigationFailed?: ((reason: string, missionId: string) => void) | undefined;
    logger?: NavigationLogger | undefined;
  }
) {
  return createTree(
    parallel(
      'companion',
      [
        reactiveSelector('primary', [
          survivalSubtree(available),
          combatSubtree(available),
          workSubtree(available, options),
          action('idle', () => ({ actionType: 'Idle', targetId: null, params: {} })),
        ]),
        maintenanceSubtree(available),
      ],
      { persistent: true }
    )
  );
}
