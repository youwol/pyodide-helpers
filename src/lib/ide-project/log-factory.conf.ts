import { logFactory as parentLogFactor } from '@youwol/logging'
import { setup } from '../../auto-generated'

export function logFactory() {
    return parentLogFactor().getChildFactory(setup.name + '/ide-project')
}
