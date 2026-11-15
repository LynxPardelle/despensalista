import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { PantryPageComponent } from './pantry-page.component';
import { PlusHouseholdSummaryComponent } from './plus-household-summary.component';

const routes: Routes = [
  {
    path: '',
    component: PantryPageComponent,
  },
];

@NgModule({
  declarations: [PantryPageComponent],
  imports: [CommonModule, ReactiveFormsModule, RouterModule.forChild(routes), PlusHouseholdSummaryComponent],
})
export class PantryModule {}
