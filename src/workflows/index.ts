import { postWorkflow } from './post';
import { onboardingWorkflow } from './onboarding';
import { deleteWorkflow } from './delete';

export const WORKFLOWS = [postWorkflow, onboardingWorkflow, deleteWorkflow];
